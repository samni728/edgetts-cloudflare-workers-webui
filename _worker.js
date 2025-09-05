/**
 * A Cloudflare Worker for proxying Microsoft Edge's TTS service with embedded WebUI.
 *
 * @version 2.4.0 (Unified Edition)
 * @description Combined the TTS service and WebUI into a single _worker.js file
 * for Cloudflare Pages deployment.
 */

// =================================================================================
// Configuration
// =================================================================================

const API_KEY = globalThis.API_KEY;
const DEFAULT_CONCURRENCY = 10; // This now acts as the BATCH SIZE
const DEFAULT_CHUNK_SIZE = 300;
const OPENAI_VOICE_MAP = {
    "shimmer": "zh-CN-XiaoxiaoNeural",
    "alloy": "zh-CN-YunyangNeural",
    "fable": "zh-CN-YunjianNeural",
    "onyx": "zh-CN-XiaoyiNeural",
    "nova": "zh-CN-YunxiNeural",
    "echo": "zh-CN-liaoning-XiaobeiNeural"
};

// =================================================================================
// Main Event Listener
// =================================================================================

addEventListener("fetch", event => {
    event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
    const request = event.request;
    const url = new URL(request.url);
    
    // Serve WebUI for root path
    if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(getWebUIHTML(), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });
    }
    
    if (request.method === "OPTIONS") return handleOptions(request);

    if (API_KEY) {
        const authHeader = request.headers.get("authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== API_KEY) {
            return errorResponse("Invalid API key.", 401, "invalid_api_key");
        }
    }

    try {
        if (url.pathname === "/v1/audio/speech") return await handleSpeechRequest(request);
        if (url.pathname === "/v1/models") return handleModelsRequest();
    } catch (err) {
        console.error("Error in request handler:", err);
        return errorResponse(err.message, 500, "internal_server_error");
    }

    return errorResponse("Not Found", 404, "not_found");
}

// =================================================================================
// Route Handlers
// =================================================================================

function handleOptions(request) {
    const headers = makeCORSHeaders(request.headers.get("Access-Control-Request-Headers"));
    return new Response(null, { status: 204, headers });
}

async function handleSpeechRequest(request) {
    if (request.method !== "POST") return errorResponse("Method Not Allowed", 405, "method_not_allowed");

    const requestBody = await request.json();
    if (!requestBody.input) return errorResponse("'input' is a required parameter.", 400, "invalid_request_error");

    const {
        model = "tts-1",
        input,
        voice = "zh-CN-XiaoxiaoNeural",
        speed = 1.0,
        pitch = 1.0,
        style = "general",
        stream = false,
        concurrency = DEFAULT_CONCURRENCY,
        chunk_size = DEFAULT_CHUNK_SIZE,
        cleaning_options = {}
    } = requestBody;

    const finalCleaningOptions = { remove_markdown: true, remove_emoji: true, remove_urls: true, remove_line_breaks: true, remove_citation_numbers: true, custom_keywords: "", ...cleaning_options };
    const cleanedInput = cleanText(input, finalCleaningOptions);

    const modelVoice = OPENAI_VOICE_MAP[model.replace('tts-1-', '')] || OPENAI_VOICE_MAP[voice];
    const finalVoice = modelVoice || voice;
    
    const rate = ((speed - 1) * 100).toFixed(0);
    const finalPitch = ((pitch - 1) * 100).toFixed(0);
    const outputFormat = "audio-24khz-48kbitrate-mono-mp3";

    const textChunks = smartChunkText(cleanedInput, chunk_size);
    const ttsArgs = [finalVoice, rate, finalPitch, style, outputFormat];

    if (stream) {
        return await streamVoice(textChunks, concurrency, ...ttsArgs);
    } else {
        return await getVoice(textChunks, concurrency, ...ttsArgs);
    }
}

function handleModelsRequest() {
    const models = [
        { id: 'tts-1', object: 'model', created: Date.now(), owned_by: 'openai' },
        { id: 'tts-1-hd', object: 'model', created: Date.now(), owned_by: 'openai' },
        ...Object.keys(OPENAI_VOICE_MAP).map(v => ({ id: `tts-1-${v}`, object: 'model', created: Date.now(), owned_by: 'openai' }))
    ];
    return new Response(JSON.stringify({ object: "list", data: models }), {
        headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    });
}

// =================================================================================
// Core TTS Logic (with Automatic Batch Processing)
// =================================================================================

async function streamVoice(textChunks, concurrency, ...ttsArgs) {
    const { readable, writable } = new TransformStream();
    try {
        // Wait for the streaming pipeline to finish so we can catch errors.
        await pipeChunksToStream(writable.getWriter(), textChunks, concurrency, ...ttsArgs);
        return new Response(readable, { headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() } });
    } catch (error) {
        console.error("Streaming TTS failed:", error);
        return errorResponse(error.message, 500, "tts_generation_error");
    }
}

async function pipeChunksToStream(writer, chunks, concurrency, ...ttsArgs) {
    try {
        // Process chunks in batches to stay within Cloudflare's subrequest limits.
        for (let i = 0; i < chunks.length; i += concurrency) {
            const batch = chunks.slice(i, i + concurrency);
            const audioPromises = batch.map(chunk => getAudioChunk(chunk, ...ttsArgs));
            // Await only the current batch.
            const audioBlobs = await Promise.all(audioPromises);
            for (const blob of audioBlobs) {
                writer.write(new Uint8Array(await blob.arrayBuffer()));
            }
        }
    } catch (error) {
        console.error("Streaming TTS failed:", error);
        writer.abort(error);
        throw error;
    } finally {
        writer.close();
    }
}

async function getVoice(textChunks, concurrency, ...ttsArgs) {
    const allAudioBlobs = [];
    try {
        // Process chunks in batches for non-streaming mode as well.
        for (let i = 0; i < textChunks.length; i += concurrency) {
            const batch = textChunks.slice(i, i + concurrency);
            const audioPromises = batch.map(chunk => getAudioChunk(chunk, ...ttsArgs));
            // Await the current batch and collect the results.
            const audioBlobs = await Promise.all(audioPromises);
            allAudioBlobs.push(...audioBlobs);
        }
        const concatenatedAudio = new Blob(allAudioBlobs, { type: 'audio/mpeg' });
        return new Response(concatenatedAudio, { headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() } });
    } catch (error) {
        console.error("Non-streaming TTS failed:", error);
        return errorResponse(error.message, 500, "tts_generation_error");
    }
}

async function getAudioChunk(text, voiceName, rate, pitch, style, outputFormat) {
    const endpoint = await getEndpoint();
    const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const ssml = getSsml(text, voiceName, rate, pitch, style);
    const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": endpoint.t, "Content-Type": "application/ssml+xml", "User-Agent": "okhttp/4.5.0", "X-Microsoft-OutputFormat": outputFormat },
        body: ssml
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Edge TTS API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    return response.blob();
}

// =================================================================================
// STABLE Authentication & Helper Functions
// =================================================================================

let tokenInfo = { endpoint: null, token: null, expiredAt: null };
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60;

async function getEndpoint() {
    const now = Date.now() / 1000;
    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) return tokenInfo.endpoint;
    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = crypto.randomUUID().replace(/-/g, "");
    try {
        const response = await fetch(endpointUrl, {
            method: "POST",
            headers: { "Accept-Language": "zh-Hans", "X-ClientVersion": "4.0.530a 5fe1dc6c", "X-UserId": "0f04d16a175c411e", "X-HomeGeographicRegion": "zh-Hans-CN", "X-ClientTraceId": clientId, "X-MT-Signature": await sign(endpointUrl), "User-Agent": "okhttp/4.5.0", "Content-Type": "application/json; charset=utf-8", "Content-Length": "0", "Accept-Encoding": "gzip" }
        });
        if (!response.ok) throw new Error(`Failed to get endpoint: ${response.status}`);
        const data = await response.json();
        const jwt = data.t.split(".")[1];
        const decodedJwt = JSON.parse(atob(jwt));
        tokenInfo = { endpoint: data, token: data.t, expiredAt: decodedJwt.exp };
        console.log(`Fetched new token successfully. Valid for ${((decodedJwt.exp - now) / 60).toFixed(1)} minutes`);
        return data;
    } catch (error) {
        console.error("Failed to get endpoint:", error);
        if (tokenInfo.token) {
            console.log("Using expired cached token as a fallback");
            return tokenInfo.endpoint;
        }
        throw error;
    }
}

async function sign(urlStr) {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = crypto.randomUUID().replace(/-/g, "");
    const formattedDate = (new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT";
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = await base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const signData = await hmacSha256(decode, bytesToSign);
    const signBase64 = await bytesToBase64(signData);
    return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: { name: "SHA-256" } }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
    return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes;
}

async function bytesToBase64(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes));
}

// =================================================================================
// General Utility Functions
// =================================================================================

function getSsml(text, voiceName, rate, pitch, style) {
    const sanitizedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="en-US"><voice name="${voiceName}"><mstts:express-as style="${style}"><prosody rate="${rate}%" pitch="${pitch}%">${sanitizedText}</prosody></mstts:express-as></voice></speak>`;
}

function smartChunkText(text, maxChunkLength) {
    if (!text) return [];
    const chunks = [];
    let currentChunk = "";
    const sentences = text.split(/([.?!,;:\n。？！，；：\r]+)/g);
    for (const part of sentences) {
        if (currentChunk.length + part.length <= maxChunkLength) {
            currentChunk += part;
        } else {
            if (currentChunk.trim()) chunks.push(currentChunk.trim());
            currentChunk = part;
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    if (chunks.length === 0 && text.length > 0) {
        for (let i = 0; i < text.length; i += maxChunkLength) {
            chunks.push(text.substring(i, i + maxChunkLength));
        }
    }
    return chunks.filter(c => c.length > 0);
}

function cleanText(text, options) {
    let cleanedText = text;

    // PIPELINE STAGE 1: Structural & Content Removal
    if (options.remove_urls) {
        cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, '');
    }
    if (options.remove_markdown) {
        cleanedText = cleanedText.replace(/!\[.*?\]\(.*?\)/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2').replace(/`{1,3}(.*?)`{1,3}/g, '$1').replace(/#{1,6}\s/g, '');
    }
    
    // PIPELINE STAGE 2: Custom Content Removal
    if (options.custom_keywords) {
        const keywords = options.custom_keywords.split(',').map(k => k.trim()).filter(k => k);
        if (keywords.length > 0) {
            const regex = new RegExp(keywords.map(k => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'), 'g');
            cleanedText = cleanedText.replace(regex, '');
        }
    }

    // PIPELINE STAGE 3: Discrete Character Removal
    if (options.remove_emoji) {
        cleanedText = cleanedText.replace(/\p{Emoji_Presentation}/gu, '');
    }

    // PIPELINE STAGE 4: Context-Aware Formatting Cleanup
    if (options.remove_citation_numbers) {
        cleanedText = cleanedText.replace(/\s\d{1,2}(?=[.。，,;；:：]|$)/g, '');
    }

    // PIPELINE STAGE 5: General Formatting Cleanup
    if (options.remove_line_breaks) {
        cleanedText = cleanedText.replace(/\s+/g, '');
    }

    // PIPELINE STAGE 6: Final Polish
    return cleanedText.trim();
}

function errorResponse(message, status, code, type = "api_error") {
    return new Response(JSON.stringify({ error: { message, type, param: null, code } }), { status, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
}

function makeCORSHeaders(extraHeaders = "Content-Type, Authorization") {
    return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": extraHeaders, "Access-Control-Max-Age": "86400" };
}

// =================================================================================
// Embedded WebUI
// =================================================================================

function getWebUIHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TTS 服务终极测试页面 (v2.4 - 稳定流式版)</title>
    <style>
      :root {
        --primary-color: #007bff;
        --success-color: #28a745;
        --error-color: #dc3545;
        --light-gray: #f8f9fa;
        --gray: #6c757d;
        --border-color: #dee2e6;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
        background-color: var(--light-gray);
        color: #343a40;
        line-height: 1.6;
        display: flex;
        justify-content: center;
        padding: 2rem;
        margin: 0;
      }
      .container {
        max-width: 800px;
        width: 100%;
        background-color: #ffffff;
        padding: 2.5rem;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      }
      h1 {
        text-align: center;
        color: #333;
        margin-bottom: 2rem;
        font-weight: 700;
      }
      .form-group {
        margin-bottom: 1.5rem;
      }
      label {
        display: block;
        font-weight: 600;
        margin-bottom: 0.5rem;
      }
      input[type="text"],
      input[type="password"],
      select,
      textarea {
        width: 100%;
        padding: 0.8rem 1rem;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        font-size: 1rem;
        box-sizing: border-box;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      input[type="text"]:focus,
      input[type="password"]:focus,
      select:focus,
      textarea:focus {
        outline: none;
        border-color: var(--primary-color);
        box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.15);
      }
      textarea {
        resize: vertical;
        min-height: 150px;
      }
      .textarea-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.85rem;
        color: var(--gray);
        margin-top: 0.5rem;
      }
      #clear-text {
        background: none;
        border: none;
        color: var(--primary-color);
        cursor: pointer;
        padding: 0.2rem;
      }
      .grid-layout {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 1.5rem;
      }
      .slider-group {
        display: flex;
        align-items: center;
        gap: 1rem;
      }
      .slider-group input[type="range"] {
        flex-grow: 1;
      }
      .slider-group span {
        font-weight: 500;
        min-width: 40px;
        text-align: right;
      }
      .button-group {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
        margin-top: 2rem;
      }
      button {
        padding: 0.9rem 1rem;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      button:active {
        transform: scale(0.97);
      }
      #btn-generate {
        background-color: #6c757d;
        color: white;
      }
      #btn-stream {
        background-color: var(--success-color);
        color: white;
      }
      button:hover {
        opacity: 0.9;
      }
      #status {
        margin-top: 1.5rem;
        padding: 1rem;
        border-radius: 8px;
        text-align: center;
        font-weight: 500;
        display: none;
      }
      .status-info {
        background-color: #e7f3ff;
        color: #004085;
      }
      .status-success {
        background-color: #d4edda;
        color: #155724;
      }
      .status-error {
        background-color: #f8d7da;
        color: #721c24;
      }
      audio {
        width: 100%;
        margin-top: 1.5rem;
        display: none;
      }
      details {
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1.5rem;
        background-color: var(--light-gray);
      }
      summary {
        font-weight: 600;
        cursor: pointer;
        color: #333;
      }
      .checkbox-grid {
        margin-top: 1rem;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 0.8rem;
      }
      #curl-box {
        position: relative;
        background-color: #212529;
        color: #f8f9fa;
        padding: 1.5rem;
        border-radius: 8px;
        white-space: pre-wrap;
        word-wrap: break-word;
        font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
        font-size: 0.9rem;
      }
      #copy-curl {
        position: absolute;
        top: 1rem;
        right: 1rem;
        background-color: #495057;
        color: white;
        border: none;
        border-radius: 5px;
        padding: 0.4rem 0.8rem;
        cursor: pointer;
      }
      #copy-curl:hover {
        background-color: #343a40;
      }
    </style>
  </head>
  <body>
    <main class="container">
      <h1>TTS 服务终极测试页面 (v2.4)</h1>

      <details>
        <summary>API 配置</summary>
        <div class="form-group" style="margin-top: 1rem">
          <label for="baseUrl">API Base URL</label>
          <input type="text" id="baseUrl" value="${typeof location !== 'undefined' ? location.origin : 'https://你的域名'}" />
        </div>
        <div class="form-group" style="margin-bottom: 0">
          <label for="apiKey">API Key</label>
          <input type="password" id="apiKey" value="你的密钥" />
        </div>
      </details>

      <div class="form-group">
        <label for="inputText">输入文本</label>
        <textarea id="inputText">
请在这里输入文本，目前尽可能不要超过 1.5w 字每次 不然会报错 。音色映射可以自行修改 workers 的配置</textarea>
        <div class="textarea-footer">
          <span id="char-count">0 字符</span>
          <button id="clear-text">清除</button>
        </div>
      </div>

      <div class="grid-layout">
        <div class="form-group">
          <label for="voice">选择音色 (Model)</label>
          <select id="voice">
            <option value="tts-1-shimmer">shimmer (温柔女声)</option>
            <option value="tts-1-alloy" selected>alloy (专业男声)</option>
            <option value="tts-1-fable">fable (激情男声)</option>
            <option value="tts-1-onyx">onyx (活泼女声)</option>
            <option value="tts-1-nova">nova (阳光男声)</option>
            <option value="tts-1-echo">echo (东北女声)</option>
          </select>
        </div>
        <div class="form-group">
          <label>语速</label>
          <div class="slider-group">
            <input
              type="range"
              id="speed"
              min="0.25"
              max="2.0"
              value="1.0"
              step="0.05"
            />
            <span id="speed-value">1.00</span>
          </div>
        </div>
        <div class="form-group">
          <label>音调</label>
          <div class="slider-group">
            <input
              type="range"
              id="pitch"
              min="0.5"
              max="1.5"
              value="1.0"
              step="0.05"
            />
            <span id="pitch-value">1.00</span>
          </div>
        </div>
      </div>

      <details>
        <summary>高级文本清理选项</summary>
        <div class="checkbox-grid">
          <label
            ><input type="checkbox" id="removeMarkdown" checked /> 移除
            Markdown</label
          >
          <label
            ><input type="checkbox" id="removeEmoji" checked /> 移除
            Emoji</label
          >
          <label
            ><input type="checkbox" id="removeUrls" checked /> 移除 URL</label
          >
          <label
            ><input type="checkbox" id="removeLineBreaks" checked />
            移除所有空白/换行</label
          >
          <label
            ><input type="checkbox" id="removeCitation" checked />
            移除引用标记数字</label
          >
        </div>
        <div class="form-group" style="margin-top: 1rem; margin-bottom: 0">
          <label for="customKeywords">自定义移除关键词 (逗号分隔)</label>
          <input type="text" id="customKeywords" placeholder="例如: ABC,XYZ" />
        </div>
      </details>

      <div class="button-group">
        <button id="btn-generate">生成语音 (标准)</button>
        <button id="btn-stream">生成语音 (流式)</button>
      </div>

      <div id="status"></div>
      <audio id="audioPlayer" controls></audio>

      <details id="curl-details" style="margin-top: 2rem">
        <summary>cURL 命令示例 (固定格式)</summary>
        <pre
          id="curl-box"
        ><code>curl --location 'https://your-worker-url/v1/audio/speech' \\
--header 'Authorization: Bearer YOUR_API_KEY' \\
--header 'Content-Type: application/json' \\
--data '{
    "model": "tts-1-alloy",
    "input": "你好，世界！",
    "stream": true
}' \\
--output speech.mp3</code></pre>
        <button id="copy-curl">复制</button>
      </details>
    </main>

    <script>
      document.addEventListener("DOMContentLoaded", () => {
        const elements = {
          baseUrl: document.getElementById("baseUrl"),
          apiKey: document.getElementById("apiKey"),
          inputText: document.getElementById("inputText"),
          charCount: document.getElementById("char-count"),
          clearText: document.getElementById("clear-text"),
          voice: document.getElementById("voice"),
          speed: document.getElementById("speed"),
          speedValue: document.getElementById("speed-value"),
          pitch: document.getElementById("pitch"),
          pitchValue: document.getElementById("pitch-value"),
          btnGenerate: document.getElementById("btn-generate"),
          btnStream: document.getElementById("btn-stream"),
          status: document.getElementById("status"),
          audioPlayer: document.getElementById("audioPlayer"),
          removeMarkdown: document.getElementById("removeMarkdown"),
          removeEmoji: document.getElementById("removeEmoji"),
          removeUrls: document.getElementById("removeUrls"),
          removeLineBreaks: document.getElementById("removeLineBreaks"),
          removeCitation: document.getElementById("removeCitation"),
          customKeywords: document.getElementById("customKeywords"),
          curlBox: document.querySelector("#curl-box code"),
          copyCurl: document.getElementById("copy-curl"),
        };

        const updateCharCount = () =>
          (elements.charCount.textContent = \`\${elements.inputText.value.length} 字符\`);

        elements.inputText.addEventListener("input", updateCharCount);
        elements.clearText.addEventListener("click", () => {
          elements.inputText.value = "";
          updateCharCount();
        });

        elements.speed.addEventListener(
          "input",
          () =>
            (elements.speedValue.textContent = parseFloat(
              elements.speed.value
            ).toFixed(2))
        );
        elements.pitch.addEventListener(
          "input",
          () =>
            (elements.pitchValue.textContent = parseFloat(
              elements.pitch.value
            ).toFixed(2))
        );

        elements.btnGenerate.addEventListener("click", () =>
          generateSpeech(false)
        );
        elements.btnStream.addEventListener("click", () =>
          generateSpeech(true)
        );
        elements.copyCurl.addEventListener("click", copyCurlToClipboard);

        function copyCurlToClipboard() {
          navigator.clipboard
            .writeText(elements.curlBox.textContent)
            .then(() => {
              elements.copyCurl.textContent = "已复制!";
              setTimeout(() => (elements.copyCurl.textContent = "复制"), 2000);
            })
            .catch((err) => console.error("Could not copy text: ", err));
        }

        function getRequestBody() {
          return {
            model: elements.voice.value,
            input: elements.inputText.value.trim(),
            speed: parseFloat(elements.speed.value),
            pitch: parseFloat(elements.pitch.value),
            cleaning_options: {
              remove_markdown: elements.removeMarkdown.checked,
              remove_emoji: elements.removeEmoji.checked,
              remove_urls: elements.removeUrls.checked,
              remove_line_breaks: elements.removeLineBreaks.checked,
              remove_citation_numbers: elements.removeCitation.checked,
              custom_keywords: elements.customKeywords.value,
            },
          };
        }

        async function generateSpeech(isStream) {
          const baseUrl = elements.baseUrl.value.trim();
          const apiKey = elements.apiKey.value.trim();
          const text = elements.inputText.value.trim();

          if (!baseUrl || !apiKey || !text) {
            updateStatus("请填写 API 配置和输入文本", "error");
            return;
          }

          const requestBody = getRequestBody();
          requestBody.stream = isStream;

          elements.audioPlayer.style.display = "none";
          elements.audioPlayer.src = "";
          updateStatus("正在连接服务器...", "info");

          try {
            if (isStream) {
              await playStreamWithMSE(baseUrl, apiKey, requestBody);
            } else {
              await playStandard(baseUrl, apiKey, requestBody);
            }
          } catch (error) {
            console.error("Error generating speech:", error);
            updateStatus(\`错误: \${error.message}\`, "error");
          }
        }

        async function playStandard(baseUrl, apiKey, body) {
          const response = await fetch(\`\${baseUrl}/v1/audio/speech\`, {
            method: "POST",
            headers: {
              Authorization: \`Bearer \${apiKey}\`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(
              errorData.error.message ||
                \`HTTP error! status: \${response.status}\`
            );
          }
          const blob = await response.blob();
          const audioUrl = URL.createObjectURL(blob);
          elements.audioPlayer.src = audioUrl;
          elements.audioPlayer.style.display = "block";
          elements.audioPlayer.play();
          updateStatus("播放中...", "success");
        }

        async function playStreamWithMSE(baseUrl, apiKey, body) {
          const mediaSource = new MediaSource();
          elements.audioPlayer.src = URL.createObjectURL(mediaSource);
          elements.audioPlayer.style.display = "block";

          mediaSource.addEventListener(
            "sourceopen",
            async () => {
              URL.revokeObjectURL(elements.audioPlayer.src);
              const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");

              try {
                const response = await fetch(\`\${baseUrl}/v1/audio/speech\`, {
                  method: "POST",
                  headers: {
                    Authorization: \`Bearer \${apiKey}\`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(body),
                });

                if (!response.ok) {
                  const errorData = await response.json();
                  throw new Error(
                    errorData.error.message ||
                      \`HTTP error! status: \${response.status}\`
                  );
                }

                updateStatus("已连接，接收数据中...", "info");
                elements.audioPlayer
                  .play()
                  .catch((e) => console.warn("Autoplay was prevented:", e));

                const reader = response.body.getReader();

                const pump = async () => {
                  const { done, value } = await reader.read();

                  if (done) {
                    if (
                      mediaSource.readyState === "open" &&
                      !sourceBuffer.updating
                    ) {
                      mediaSource.endOfStream();
                    }
                    updateStatus("播放完毕！", "success");
                    return;
                  }

                  if (sourceBuffer.updating) {
                    await new Promise((resolve) =>
                      sourceBuffer.addEventListener("updateend", resolve, {
                        once: true,
                      })
                    );
                  }

                  sourceBuffer.appendBuffer(value);
                  updateStatus("正在流式播放...", "success");
                };

                sourceBuffer.addEventListener("updateend", pump);
                await pump();
              } catch (error) {
                console.error("Error in MSE streaming:", error);
                updateStatus(\`错误: \${error.message}\`, "error");
                if (mediaSource.readyState === "open") {
                  try {
                    mediaSource.endOfStream();
                  } catch (e) {}
                }
              }
            },
            { once: true }
          );
        }

        function updateStatus(message, type) {
          elements.status.textContent = message;
          elements.status.className = \`status-\${type}\`;
          elements.status.style.display = "block";
        }

        updateCharCount();
      });
    </script>
  </body>
</html>`;
}