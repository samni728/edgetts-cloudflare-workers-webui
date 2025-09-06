/**
 * A Cloudflare Worker for proxying Microsoft Edge's TTS service with embedded WebUI.
 *
 * @version 7.0.0 (UI & Auth Fix - Final)
 * @description This version fixes the API key validation logic, restores the cURL example,
 * corrects UI alignment, and enables the streaming functionality. It's the definitive release.
 */

// =================================================================================
// Configuration & Global State
// =================================================================================

// Environment variables will be accessed directly from globalThis when needed
const MAX_STORAGE_SIZE = 1024 * 1024 * 1024; // 1GB limit
const OPENAI_VOICE_MAP = {
  shimmer: "zh-CN-XiaoxiaoNeural",
  alloy: "zh-CN-YunyangNeural",
  fable: "zh-CN-YunjianNeural",
  onyx: "zh-CN-XiaoyiNeural",
  nova: "zh-CN-YunxiNeural",
  echo: "zh-CN-liaoning-XiaobeiNeural",
};
let tokenInfo = { endpoint: null, token: null, expiredAt: null };
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60;

// =================================================================================
// Cloudflare Pages Entry Point
// =================================================================================

export default {
  async fetch(request, env, ctx) {
    if (env.API_KEY) {
      globalThis.API_KEY = env.API_KEY;
    }
    if (env.TTS_HISTORY) {
      globalThis.TTS_HISTORY = env.TTS_HISTORY;
    }
    return await handleRequest(request);
  },
};

// =================================================================================
// Main Request Handler
// =================================================================================

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(getWebUIHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  
  // Handle favicon
  if (url.pathname === "/favicon.ico") {
    return new Response(getFaviconSVG(), {
      headers: { "Content-Type": "image/svg+xml" },
    });
  }
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  if (url.pathname.startsWith("/v1/")) {
    if (globalThis.API_KEY) {
      const authHeader = request.headers.get("authorization");
      if (
        !authHeader ||
        !authHeader.startsWith("Bearer ") ||
        authHeader.slice(7) !== globalThis.API_KEY
      ) {
        return errorResponse("Invalid API key.", 401, "invalid_api_key");
      }
    }
  }

  try {
    if (url.pathname === "/v1/audio/speech")
      return await handleSpeechRequest(request);
    if (url.pathname === "/v1/models") return handleModelsRequest();
    if (url.pathname === "/history") return await handleHistoryRequest(request);
    if (url.pathname.startsWith("/share/")) return await handleShareRequest(request);
    if (url.pathname === "/api/save") return await handleSaveRequest(request);
    if (url.pathname === "/api/history") return await handleHistoryApiRequest(request);
    if (url.pathname.startsWith("/api/audio/")) return await handleAudioRequest(request);
  } catch (err) {
    return errorResponse(err.message, 500, "internal_server_error");
  }

  return errorResponse("Not Found", 404, "not_found");
}

// =================================================================================
// API Route Handlers
// =================================================================================

// Handle save TTS to history
async function handleSaveRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");
  }

  if (!globalThis.TTS_HISTORY) {
    return errorResponse("KV storage not configured", 500, "storage_error");
  }

  try {
    // Parse FormData
    const formData = await request.formData();
    const text = formData.get('text');
    const voice = formData.get('voice');
    const speed = parseFloat(formData.get('speed'));
    const pitch = parseFloat(formData.get('pitch'));
    const cleaningOptions = JSON.parse(formData.get('cleaningOptions') || '{}');
    const audioFile = formData.get('audioFile');
    
    if (!text || !audioFile) {
      return errorResponse("Missing required fields", 400, "invalid_request");
    }

    // Generate unique ID
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    
    // Get audio data as ArrayBuffer
    const audioArrayBuffer = await audioFile.arrayBuffer();
    const audioData = new Uint8Array(audioArrayBuffer);
    
    // Create metadata
    const metadata = {
      id,
      text,
      voice,
      speed,
      pitch,
      cleaningOptions,
      timestamp,
      summary: text.substring(0, 100) + (text.length > 100 ? "..." : ""),
      size: audioData.length
    };
    
    // Check storage limit and clean if necessary
    await cleanupStorageIfNeeded(audioData.length);
    
    // Save audio data directly (no encoding needed)
    await globalThis.TTS_HISTORY.put(`audio_${id}`, audioData, {
      metadata: { type: "audio", timestamp }
    });

    // Save metadata
    await globalThis.TTS_HISTORY.put(`meta_${id}`, JSON.stringify(metadata), {
      metadata: { type: "metadata", timestamp }
    });

    // Update history index
    await updateHistoryIndex(id, metadata);

    return new Response(JSON.stringify({ success: true, id, shareUrl: `/share/${id}` }), {
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    });

  } catch (error) {
    return errorResponse(`Save failed: ${error.message}`, 500, "save_error");
  }
}

// Handle history page
async function handleHistoryRequest(request) {
  return new Response(getHistoryPageHTML(), {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

// Handle history API
async function handleHistoryApiRequest(request) {
  if (!globalThis.TTS_HISTORY) {
    return errorResponse("KV storage not configured", 500, "storage_error");
  }

  try {
    const historyData = await globalThis.TTS_HISTORY.get("history_index");
    const history = historyData ? JSON.parse(historyData) : [];
    
    // Sort by timestamp (newest first)
    history.sort((a, b) => b.timestamp - a.timestamp);

    return new Response(JSON.stringify({ history }), {
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    });
  } catch (error) {
    return errorResponse(`Failed to load history: ${error.message}`, 500, "history_error");
  }
}

// Handle share page
async function handleShareRequest(request) {
  const url = new URL(request.url);
  const id = url.pathname.split("/")[2];

  if (!id || !globalThis.TTS_HISTORY) {
    return errorResponse("Invalid share link", 404, "not_found");
  }

  try {
    const metadataStr = await globalThis.TTS_HISTORY.get(`meta_${id}`);
    if (!metadataStr) {
      return errorResponse("Share link not found", 404, "not_found");
    }

    const metadata = JSON.parse(metadataStr);
    const audioData = await globalThis.TTS_HISTORY.get(`audio_${id}`);

    if (!audioData) {
      return errorResponse("Audio data not found", 404, "not_found");
    }

    return new Response(getSharePageHTML(metadata, id), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  } catch (error) {
    return errorResponse(`Failed to load share page: ${error.message}`, 500, "share_error");
  }
}

// Handle audio file serving
async function handleAudioRequest(request) {
  const url = new URL(request.url);
  const id = url.pathname.split("/")[3];

  if (!id || !globalThis.TTS_HISTORY) {
    return errorResponse("Invalid audio request", 404, "not_found");
  }

  try {
    const audioData = await globalThis.TTS_HISTORY.get(`audio_${id}`, "arrayBuffer");
    if (!audioData) {
      return errorResponse("Audio not found", 404, "not_found");
    }

    return new Response(audioData, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioData.byteLength.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
        ...makeCORSHeaders()
      }
    });
  } catch (error) {
    return errorResponse(`Failed to serve audio: ${error.message}`, 500, "audio_error");
  }
}

function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...makeCORSHeaders(),
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") ||
        "Authorization, Content-Type",
    },
  });
}

async function handleSpeechRequest(request) {
  if (request.method !== "POST")
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");

  const requestBody = await request.json();
  if (!requestBody.input)
    return errorResponse(
      "'input' is a required parameter.",
      400,
      "invalid_request_error"
    );

  const {
    model = "tts-1",
    input,
    voice,
    speed = 1.0,
    pitch = 1.0,
    style = "general",
    stream = false,
    cleaning_options = {},
  } = requestBody;

  const finalVoice =
    OPENAI_VOICE_MAP[model.replace("tts-1-", "")] ||
    voice ||
    "zh-CN-XiaoxiaoNeural";
  const finalCleaningOptions = {
    remove_markdown: true,
    remove_emoji: true,
    remove_urls: true,
    remove_line_breaks: false,
    remove_citation_numbers: true,
    custom_keywords: "",
    ...cleaning_options,
  };
  const cleanedInput = cleanText(input, finalCleaningOptions);
  const rate = ((speed - 1) * 100).toFixed(0);
  const numPitch = ((pitch - 1) * 100).toFixed(0);
  const outputFormat = "audio-24khz-48kbitrate-mono-mp3";

  if (stream) {
    return await getVoiceStream(
      cleanedInput,
      finalVoice,
      rate,
      numPitch,
      style,
      outputFormat
    );
  } else {
    return await getVoice(
      cleanedInput,
      finalVoice,
      rate,
      numPitch,
      style,
      outputFormat
    );
  }
}

function handleModelsRequest() {
  const models = [
    { id: "tts-1", object: "model", created: Date.now(), owned_by: "openai" },
    {
      id: "tts-1-hd",
      object: "model",
      created: Date.now(),
      owned_by: "openai",
    },
    ...Object.keys(OPENAI_VOICE_MAP).map((v) => ({
      id: `tts-1-${v}`,
      object: "model",
      created: Date.now(),
      owned_by: "openai",
    })),
  ];
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
  });
}

// =================================================================================
// Core TTS Logic (Android App Simulation)
// =================================================================================

async function getVoice(text, voiceName, rate, pitch, style, outputFormat) {
  const maxChunkSize = 2000;
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChunkSize) {
    chunks.push(text.slice(i, i + maxChunkSize));
  }
  const audioChunks = await Promise.all(
    chunks.map((chunk) =>
      getAudioChunk(chunk, voiceName, rate, pitch, style, outputFormat)
    )
  );
  const concatenatedAudio = new Blob(audioChunks, { type: "audio/mpeg" });
  return new Response(concatenatedAudio, {
    headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() },
  });
}

async function getVoiceStream(
  text,
  voiceName,
  rate,
  pitch,
  style,
  outputFormat
) {
  const maxChunkSize = 2000;
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChunkSize) {
    chunks.push(text.slice(i, i + maxChunkSize));
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      for (const chunk of chunks) {
        const audioBlob = await getAudioChunk(
          chunk,
          voiceName,
          rate,
          pitch,
          style,
          outputFormat
        );
        const arrayBuffer = await audioBlob.arrayBuffer();
        await writer.write(new Uint8Array(arrayBuffer));
      }
    } catch (error) {
      await writer.abort(error);
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() },
  });
}

async function getAudioChunk(
  text,
  voiceName,
  rate,
  pitch,
  style,
  outputFormat
) {
  const endpoint = await getEndpoint();
  const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"><voice name="${voiceName}"><mstts:express-as style="${style}"><prosody rate="${rate}%" pitch="${pitch}%">${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</prosody></mstts:express-as></voice></speak>`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: endpoint.t,
      "Content-Type": "application/ssml+xml",
      "User-Agent": "okhttp/4.5.0",
      "X-Microsoft-OutputFormat": outputFormat,
    },
    body: ssml,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge TTS API error: ${response.status} ${errorText}`);
  }
  return response.blob();
}

async function getEndpoint() {
  const now = Date.now() / 1000;
  if (
    tokenInfo.token &&
    now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY
  ) {
    return tokenInfo.endpoint;
  }
  
  const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const clientId = crypto.randomUUID().replace(/-/g, "");
  
  // 重试机制
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Accept-Language": "zh-Hans",
          "X-ClientVersion": "4.0.530a 5fe1dc6c",
          "X-UserId": "0f04d16a175c411e",
          "X-HomeGeographicRegion": "zh-Hans-CN",
          "X-ClientTraceId": clientId,
          "X-MT-Signature": await sign(endpointUrl),
          "User-Agent": "okhttp/4.5.0",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": "0",
          "Accept-Encoding": "gzip",
        },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      const jwt = data.t.split(".")[1];
      const decodedJwt = JSON.parse(atob(jwt));
      tokenInfo = { endpoint: data, token: data.t, expiredAt: decodedJwt.exp };
      return data;
    } catch (error) {
      lastError = error;
      console.error(`Endpoint attempt ${attempt} failed:`, error.message);
      
      // 如果不是最后一次尝试，等待一下再重试
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  // 如果所有重试都失败，尝试使用缓存的 token
  if (tokenInfo.token) {
    console.warn("Using cached token due to endpoint failures");
    return tokenInfo.endpoint;
  }
  
  throw new Error(`Failed to get endpoint after 3 attempts: ${lastError.message}`);
}

async function sign(urlStr) {
  const url = urlStr.split("://")[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = crypto.randomUUID().replace(/-/g, "");
  const formattedDate =
    new Date().toUTCString().replace(/GMT/, "").trim() + " GMT";
  const bytesToSign =
    `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
  const keyBytes = await base64ToBytes(
    "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=="
  );
  const signatureBytes = await hmacSha256(keyBytes, bytesToSign);
  const signatureBase64 = await bytesToBase64(signatureBytes);
  return `MSTranslatorAndroidApp::${signatureBase64}::${formattedDate}::${uuidStr}`;
}

// =================================================================================
// Storage Management Functions
// =================================================================================

async function cleanupStorageIfNeeded(newItemSize) {
  if (!globalThis.TTS_HISTORY) return;

  try {
    // Get current storage usage
    const historyData = await globalThis.TTS_HISTORY.get("history_index");
    const history = historyData ? JSON.parse(historyData) : [];
    
    let totalSize = history.reduce((sum, item) => sum + (item.size || 0), 0);
    
    // If adding new item would exceed limit, remove oldest items
    while (totalSize + newItemSize > MAX_STORAGE_SIZE && history.length > 0) {
      const oldestItem = history.shift(); // Remove oldest
      totalSize -= (oldestItem.size || 0);
      
      // Delete from KV
      await globalThis.TTS_HISTORY.delete(`audio_${oldestItem.id}`);
      await globalThis.TTS_HISTORY.delete(`meta_${oldestItem.id}`);
    }
    
    // Update history index
    await globalThis.TTS_HISTORY.put("history_index", JSON.stringify(history));
  } catch (error) {
    console.error("Cleanup failed:", error);
  }
}

async function updateHistoryIndex(id, metadata) {
  if (!globalThis.TTS_HISTORY) return;

  try {
    const historyData = await globalThis.TTS_HISTORY.get("history_index");
    const history = historyData ? JSON.parse(historyData) : [];
    
    // Add new item to beginning
    history.unshift({
      id: metadata.id,
      summary: metadata.summary,
      timestamp: metadata.timestamp,
      voice: metadata.voice,
      size: metadata.size
    });
    
    // Keep only last 1000 items for performance
    if (history.length > 1000) {
      history.splice(1000);
    }
    
    await globalThis.TTS_HISTORY.put("history_index", JSON.stringify(history));
  } catch (error) {
    console.error("Failed to update history index:", error);
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderMarkdown(text) {
  if (!text) return '';
  
  // 简单的Markdown渲染
  let html = text
    // 转义HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    
    // 标题
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    
    // 粗体和斜体
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    
    // 代码
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    
    // 换行处理
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
    
  // 包装在段落中
  if (html && !html.startsWith('<h') && !html.startsWith('<p>')) {
    html = '<p>' + html + '</p>';
  }
  
  return html;
}

// =================================================================================
// Utility Functions
// =================================================================================

function cleanText(text, options) {
  let cleanedText = text;
  if (options.remove_urls)
    cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, "");
  if (options.remove_markdown)
    cleanedText = cleanedText
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/`{1,3}(.*?)`{1,3}/g, "$1")
      .replace(/#{1,6}\s/g, "");
  if (options.custom_keywords) {
    const keywords = options.custom_keywords
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k);
    if (keywords.length > 0) {
      const regex = new RegExp(
        keywords
          .map((k) => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"))
          .join("|"),
        "g"
      );
      cleanedText = cleanedText.replace(regex, "");
    }
  }
  if (options.remove_emoji)
    cleanedText = cleanedText.replace(/\p{Emoji_Presentation}/gu, "");
  if (options.remove_citation_numbers)
    cleanedText = cleanedText.replace(/\[\d+\]/g, "").replace(/【\d+】/g, "");
  if (options.remove_line_breaks) {
    // 移除换行符，不添加空格，直接连接文本
    cleanedText = cleanedText.replace(/(\r\n|\n|\r)/gm, "");
    // 合并多个连续空格为单个空格
    return cleanedText.trim().replace(/\s+/g, " ");
  } else {
    // 保留换行符，只合并非换行的连续空格
    return cleanedText.trim().replace(/[ \t]+/g, " ");
  }
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data)
  );
  return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++)
    bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function bytesToBase64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}

function errorResponse(message, status, code) {
  return new Response(
    JSON.stringify({ error: { message, type: "api_error", code } }),
    {
      status,
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
    }
  );
}

function makeCORSHeaders(extraHeaders = "Content-Type, Authorization") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": extraHeaders,
    "Access-Control-Max-Age": "86400",
  };
}

// =================================================================================
// Favicon and Assets
// =================================================================================

function getFaviconSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="45" fill="#007bff"/>
    <text x="50" y="65" font-family="Arial, sans-serif" font-size="40" fill="white" text-anchor="middle">🎵</text>
  </svg>`;
}

// =================================================================================
// Embedded WebUI (v7.0 - UI & Auth Fix)
// =================================================================================

function getSharePageHTML(metadata, id) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TTS 分享 - ${metadata.summary}</title>
  <meta name="description" content="${metadata.summary}">
  <style>
    :root { --primary-color: #007bff; --success-color: #28a745; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.8; margin: 0; padding: 1rem; }
    .container { max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    .header { text-align: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color); }
    .title { font-size: 1.5rem; font-weight: 700; color: #333; margin-bottom: 0.5rem; }
    .meta { font-size: 0.9rem; color: var(--gray); }
    .content { margin: 2rem 0; }
    .content h1, .content h2, .content h3, .content h4, .content h5, .content h6 { color: #333; margin-top: 1.5rem; margin-bottom: 0.5rem; }
    .content h1 { font-size: 1.8rem; border-bottom: 2px solid var(--primary-color); padding-bottom: 0.5rem; }
    .content h2 { font-size: 1.5rem; }
    .content h3 { font-size: 1.3rem; }
    .content p { margin-bottom: 1rem; }
    .content blockquote { border-left: 4px solid var(--primary-color); padding-left: 1rem; margin: 1rem 0; font-style: italic; color: var(--gray); }
    .content code { background-color: #f1f3f4; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: 'Courier New', monospace; }
    .content pre { background-color: #f8f9fa; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    .content ul, .content ol { margin-bottom: 1rem; padding-left: 2rem; }
    .content li { margin-bottom: 0.3rem; }
    .content strong { font-weight: 600; }
    .content em { font-style: italic; }
    .audio-section { background-color: var(--light-gray); padding: 1.5rem; border-radius: 8px; margin: 2rem 0; text-align: center; }
    .play-button { background-color: var(--success-color); color: white; border: none; padding: 1rem 2rem; border-radius: 50px; font-size: 1.1rem; cursor: pointer; margin-bottom: 1rem; display: inline-flex; align-items: center; gap: 0.5rem; }
    .play-button:hover { background-color: #218838; }
    .audio-player { width: 100%; margin-top: 1rem; display: none; }
    .footer { text-align: center; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-color); }
    .share-buttons { display: flex; justify-content: center; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; }
    .share-btn { padding: 0.5rem 1rem; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; font-size: 0.9rem; }
    .share-copy { background-color: var(--primary-color); color: white; }
    .back-link { color: var(--gray); text-decoration: none; font-size: 0.9rem; }
    @media (max-width: 768px) {
      .container { padding: 1rem; margin: 0.5rem; }
      .title { font-size: 1.3rem; }
      .content h1 { font-size: 1.5rem; }
      .play-button { padding: 0.8rem 1.5rem; font-size: 1rem; }
      .share-buttons { flex-direction: column; align-items: center; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">🎵 TTS 语音分享</div>
      <div class="meta">
        ${formatDate(metadata.timestamp)} • ${metadata.voice} • ${formatFileSize(metadata.size)}
      </div>
    </div>
    
    <div class="audio-section">
      <button class="play-button" onclick="playAudio()">
        ▶️ 播放语音
      </button>
      <audio id="audioPlayer" class="audio-player" controls>
        您的浏览器不支持音频播放。
      </audio>
    </div>
    
    <div class="content" id="content">
      ${renderMarkdown(metadata.text)}
    </div>
    
    <div class="footer">
      <div class="share-buttons">
        <button class="share-btn share-copy" onclick="copyLink()">📋 复制链接</button>
      </div>
      <div style="margin-top: 1rem;">
        <a href="/" class="back-link">← 返回 TTS 服务</a>
      </div>
    </div>
  </div>

  <script>
    let audioLoaded = false;
    
    async function playAudio() {
      const audio = document.getElementById('audioPlayer');
      const button = document.querySelector('.play-button');
      
      if (!audioLoaded) {
        button.textContent = '⏳ 加载中...';
        button.disabled = true;
        
        try {
          const response = await fetch('/api/audio/${id}');
          if (response.ok) {
            const blob = await response.blob();
            
            // 验证 blob 是否有效
            if (blob.size === 0) {
              throw new Error('音频文件为空');
            }
            
            audio.src = URL.createObjectURL(blob);
            audioLoaded = true;
            button.textContent = '▶️ 播放语音';
            button.disabled = false;
            
            // 添加音频加载完成事件
            audio.addEventListener('canplaythrough', () => {
              console.log('Audio loaded successfully');
            }, { once: true });
            
            audio.addEventListener('error', (e) => {
              console.error('Audio error:', e);
              button.textContent = '❌ 播放失败';
              alert('音频播放失败，请重试');
            });
            
          } else {
            const errorText = await response.text();
            throw new Error(\`HTTP \${response.status}: \${errorText}\`);
          }
        } catch (error) {
          console.error('Audio loading error:', error);
          button.textContent = '❌ 加载失败';
          button.disabled = false;
          alert('音频加载失败: ' + error.message);
          return;
        }
      }
      
      try {
        audio.style.display = 'block';
        await audio.play();
      } catch (playError) {
        console.error('Audio play error:', playError);
        alert('播放失败: ' + playError.message);
      }
    }
    
    function copyLink() {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const btn = document.querySelector('.share-copy');
        const originalText = btn.textContent;
        btn.textContent = '✅ 已复制';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      }).catch(() => {
        prompt('复制链接:', window.location.href);
      });
    }
  </script>
</body>
</html>`;
}

function getHistoryPageHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TTS 历史记录</title>
  <style>
    :root { --primary-color: #007bff; --success-color: #28a745; --error-color: #dc3545; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.6; margin: 0; padding: 2rem; }
    .container { max-width: 1000px; margin: 0 auto; background-color: #ffffff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    h1 { text-align: center; color: #333; margin-bottom: 2rem; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
    .back-btn { background-color: var(--gray); color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 6px; cursor: pointer; text-decoration: none; }
    .history-item { border: 1px solid var(--border-color); border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; background-color: #fff; }
    .item-header { display: flex; justify-content: between; align-items: flex-start; margin-bottom: 1rem; }
    .item-summary { flex-grow: 1; font-weight: 600; color: #333; margin-bottom: 0.5rem; }
    .item-meta { font-size: 0.85rem; color: var(--gray); }
    .item-actions { display: flex; gap: 0.5rem; }
    .btn { padding: 0.4rem 0.8rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
    .btn-play { background-color: var(--success-color); color: white; }
    .btn-share { background-color: var(--primary-color); color: white; }
    .loading { text-align: center; padding: 2rem; color: var(--gray); }
    .empty { text-align: center; padding: 3rem; color: var(--gray); }
    audio { width: 100%; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📚 TTS 历史记录</h1>
      <a href="/" class="back-btn">← 返回主页</a>
    </div>
    <div id="loading" class="loading">正在加载历史记录...</div>
    <div id="history-list"></div>
  </div>

  <script>
    async function loadHistory() {
      try {
        const response = await fetch('/api/history');
        const data = await response.json();
        
        document.getElementById('loading').style.display = 'none';
        
        if (data.history.length === 0) {
          document.getElementById('history-list').innerHTML = '<div class="empty">暂无历史记录</div>';
          return;
        }
        
        const historyHtml = data.history.map(item => \`
          <div class="history-item">
            <div class="item-header">
              <div style="flex-grow: 1;">
                <div class="item-summary">\${item.summary}</div>
                <div class="item-meta">
                  \${formatDate(item.timestamp)} • \${item.voice} • \${formatFileSize(item.size)}
                </div>
              </div>
              <div class="item-actions">
                <button class="btn btn-play" onclick="playAudio('\${item.id}')">▶️ 播放</button>
                <button class="btn btn-share" onclick="shareItem('\${item.id}')">🔗 分享</button>
              </div>
            </div>
            <audio id="audio-\${item.id}" controls style="display: none;"></audio>
          </div>
        \`).join('');
        
        document.getElementById('history-list').innerHTML = historyHtml;
      } catch (error) {
        document.getElementById('loading').innerHTML = '<div class="empty">加载失败: ' + error.message + '</div>';
      }
    }
    
    function formatDate(timestamp) {
      return new Date(timestamp).toLocaleString('zh-CN');
    }
    
    function formatFileSize(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    async function playAudio(id) {
      const audio = document.getElementById(\`audio-\${id}\`);
      const button = document.querySelector(\`[onclick="playAudio('\${id}')"]\`);
      
      if (audio.src) {
        try {
          audio.style.display = 'block';
          await audio.play();
        } catch (error) {
          console.error('Audio play error:', error);
          alert('播放失败: ' + error.message);
        }
        return;
      }
      
      // 更新按钮状态
      const originalText = button.textContent;
      button.textContent = '⏳ 加载中...';
      button.disabled = true;
      
      try {
        const response = await fetch(\`/api/audio/\${id}\`);
        if (response.ok) {
          const blob = await response.blob();
          
          // 验证 blob 是否有效
          if (blob.size === 0) {
            throw new Error('音频文件为空');
          }
          
          audio.src = URL.createObjectURL(blob);
          
          // 添加错误处理
          audio.addEventListener('error', (e) => {
            console.error('Audio error:', e);
            alert('音频播放失败，请重试');
          }, { once: true });
          
          audio.style.display = 'block';
          await audio.play();
          
          button.textContent = originalText;
          button.disabled = false;
        } else {
          const errorText = await response.text();
          throw new Error(\`HTTP \${response.status}: \${errorText}\`);
        }
      } catch (error) {
        console.error('Audio loading error:', error);
        button.textContent = originalText;
        button.disabled = false;
        alert('播放失败: ' + error.message);
      }
    }
    
    function shareItem(id) {
      const shareUrl = \`\${window.location.origin}/share/\${id}\`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        alert('分享链接已复制到剪贴板！');
      }).catch(() => {
        prompt('分享链接:', shareUrl);
      });
    }
    
    loadHistory();
  </script>
</body>
</html>`;
}

function getWebUIHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CF-TTS 服务终极测试页面</title>
    <style>
      :root { --primary-color: #007bff; --success-color: #28a745; --error-color: #dc3545; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.6; display: flex; justify-content: center; padding: 2rem; margin: 0; }
      .container { max-width: 800px; width: 100%; background-color: #ffffff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
      h1 { text-align: center; color: #333; margin-bottom: 2rem; font-weight: 700; }
      .form-group { margin-bottom: 1.5rem; }
      label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
      input, select, textarea, button { width: 100%; padding: 0.8rem 1rem; border: 1px solid var(--border-color); border-radius: 8px; font-size: 1rem; box-sizing: border-box; transition: all 0.2s; }
      input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary-color); box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.15); }
      textarea { resize: vertical; min-height: 150px; }
      .textarea-footer { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; color: var(--gray); margin-top: 0.5rem; }
      #clear-text { background: none; border: none; color: var(--primary-color); cursor: pointer; padding: 0.2rem; width: auto; }
      .grid-layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; }
      .slider-group { display: flex; align-items: center; gap: 1rem; }
      .slider-group input[type="range"] { flex-grow: 1; padding: 0; }
      .slider-group span { font-weight: 500; min-width: 40px; text-align: right; }
      .button-group { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 2rem; }
      button { font-weight: 600; cursor: pointer; }
      #btn-generate { background-color: var(--primary-color); color: white; border-color: var(--primary-color); }
      #btn-stream { background-color: var(--success-color); color: white; border-color: var(--success-color); }
      #status { margin-top: 1.5rem; padding: 1rem; border-radius: 8px; text-align: center; font-weight: 500; display: none; }
      .status-info { background-color: #e7f3ff; color: #004085; }
      .status-success { background-color: #d4edda; color: #155724; }
      .status-error { background-color: #f8d7da; color: #721c24; }
      audio { width: 100%; margin-top: 1.5rem; display: none; }
      details { border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; background-color: var(--light-gray); }
      summary { font-weight: 600; cursor: pointer; }
      .checkbox-grid { margin-top: 1rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.8rem; }
      .checkbox-grid label { display: flex; align-items: center; gap: 0.5rem; font-weight: normal; margin: 0; }
      .checkbox-grid input[type="checkbox"] { width: auto; margin: 0; flex-shrink: 0; }
    </style>
  </head>
  <body>
    <main class="container">
      <h1>TTS 服务终极测试页面 (v7.0)</h1>
      <details id="api-config" open>
        <summary>API 配置</summary>
        <div class="form-group" style="margin-top: 1rem">
          <label for="baseUrl">API Base URL</label>
          <input type="text" id="baseUrl" value="" readonly/>
        </div>
        <div class="form-group">
          <label for="apiKey">API Key</label>
          <input type="password" id="apiKey" placeholder="输入部署时设置的 API Key" />
        </div>
        <button id="save-config" style="background-color: var(--primary-color); color: white;">保存并验证</button>
      </details>
      <div class="form-group">
        <label for="inputText">输入文本</label>
        <textarea id="inputText">你好，世界！[1] 这是一个 **Markdown** 格式的示例文本，包含链接 https://example.com 和 😊 表情符号。自定义关键词：ABC</textarea>
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
            <input type="range" id="speed" min="0.25" max="2.0" value="1.0" step="0.05" />
            <span id="speed-value">1.00</span>
          </div>
        </div>
        <div class="form-group">
          <label>音调</label>
          <div class="slider-group">
            <input type="range" id="pitch" min="0.5" max="1.5" value="1.0" step="0.05" />
            <span id="pitch-value">1.00</span>
          </div>
        </div>
      </div>
      <details>
        <summary>高级文本清理选项</summary>
        <div class="checkbox-grid">
          <label><input type="checkbox" id="removeMarkdown" checked />移除 Markdown</label>
          <label><input type="checkbox" id="removeEmoji" checked />移除 Emoji</label>
          <label><input type="checkbox" id="removeUrls" checked />移除 URL</label>
          <label><input type="checkbox" id="removeLineBreaks" />移除所有换行</label>
          <label><input type="checkbox" id="removeCitation" checked />移除引用标记[数字]</label>
        </div>
        <div class="form-group" style="margin-top: 1rem; margin-bottom: 0">
          <label for="customKeywords">自定义移除关键词 (逗号分隔)</label>
          <input type="text" id="customKeywords" placeholder="例如: ABC,XYZ" />
        </div>
      </details>
      <div style="margin-bottom: 1rem;">
        <label style="display: flex; align-items: center; gap: 0.5rem; font-weight: normal;">
          <input type="checkbox" id="saveToHistory" style="width: auto; margin: 0;" />
          保存到历史记录 (可分享)
        </label>
      </div>
      <div class="button-group">
        <button id="btn-generate">生成语音 (标准)</button>
        <button id="btn-stream">生成语音 (流式)</button>
      </div>
      <div style="margin-top: 1rem; text-align: center;">
        <button id="btn-history" style="background-color: #6c757d; color: white; width: auto; padding: 0.6rem 1.5rem;">
          📚 查看历史记录
        </button>
      </div>
      <div id="status"></div>
      <audio id="audioPlayer" controls></audio>
      <details id="curl-details" style="margin-top: 2rem">
        <summary>cURL 命令示例</summary>
        <div style="position: relative; background-color: #212529; color: #f8f9fa; padding: 1.5rem; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; font-family: 'Courier New', Consolas, monospace; font-size: 0.85rem; line-height: 1.4; overflow-x: auto;">
          <code id="curl-code">正在加载 cURL 示例...</code>
          <button id="copy-curl" style="position: absolute; top: 1rem; right: 1rem; background-color: #495057; color: white; border: none; border-radius: 5px; padding: 0.4rem 0.8rem; cursor: pointer; font-size: 0.8rem; width: auto;">复制</button>
        </div>
      </details>
      <footer style="text-align: center; margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--border-color); font-size: 0.85rem; color: var(--gray);">
        <div style="display: flex; justify-content: center; align-items: center; gap: 1rem;">
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="display: flex; align-items: center; gap: 0.5rem; color: var(--gray); text-decoration: none;">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub 项目
          </a>
          <span>|</span>
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="color: var(--gray); text-decoration: none;">⭐ Star</a>
        </div>
      </footer>
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
          btnHistory: document.getElementById("btn-history"),
          status: document.getElementById("status"),
          audioPlayer: document.getElementById("audioPlayer"),
          saveConfig: document.getElementById("save-config"),
          apiConfig: document.getElementById("api-config"),
          curlCode: document.getElementById("curl-code"),
          copyCurl: document.getElementById("copy-curl"),
          removeMarkdown: document.getElementById("removeMarkdown"),
          removeEmoji: document.getElementById("removeEmoji"),
          removeUrls: document.getElementById("removeUrls"),
          removeLineBreaks: document.getElementById("removeLineBreaks"),
          removeCitation: document.getElementById("removeCitation"),
          customKeywords: document.getElementById("customKeywords"),
          saveToHistory: document.getElementById("saveToHistory"),
        };

        const setCookie = (name, value, days = 30) => {
          const d = new Date();
          d.setTime(d.getTime() + (days*24*60*60*1000));
          document.cookie = name + "=" + encodeURIComponent(value) + ";expires="+ d.toUTCString() + ";path=/";
        };
        const getCookie = (name) => {
          const ca = decodeURIComponent(document.cookie).split(';');
          for(let c of ca) {
            c = c.trim();
            if (c.startsWith(name + "=")) return c.substring(name.length + 1);
          }
          return "";
        };

        const updateStatus = (message, type, persistent = false) => {
          elements.status.textContent = message;
          elements.status.className = \`status-\${type}\`;
          elements.status.style.display = "block";
          if (!persistent) {
              setTimeout(() => elements.status.style.display = "none", 3000);
          }
        };

        const updateCurlExample = () => {
          const baseUrl = elements.baseUrl.value;
          const apiKey = elements.apiKey.value.trim();
          let authHeader = apiKey ? \`--header 'Authorization: Bearer \${apiKey}' \\\\\` : '# API Key not set, authorization header is commented out';
          
          const curlCommand = \`# Standard Request
curl --location '\${baseUrl}/v1/audio/speech' \\\\
\${authHeader}
--header 'Content-Type: application/json' \\\\
--data '{
    "model": "\${elements.voice.value}",
    "input": "你好，世界！",
    "speed": \${elements.speed.value}
}' \\\\
--output speech.mp3\`;
          elements.curlCode.textContent = curlCommand;
        };

        // Event listener for Save and Validate button
        elements.saveConfig.addEventListener("click", async () => {
          const key = elements.apiKey.value.trim();
          if (!key) {
            updateStatus("请输入 API Key", "error");
            return;
          }

          // 简单保存，不进行验证（验证会在实际使用时进行）
          setCookie("apiKey", key);
          updateStatus("API Key 已保存！", "success");
          elements.apiConfig.open = false;
          updateCurlExample();
        });

        // Generate speech function with retry mechanism
        const generateSpeech = async (isStream = false, retryCount = 0) => {
          const apiKey = elements.apiKey.value.trim();
          const text = elements.inputText.value.trim();

          if (!apiKey) {
            updateStatus("请先在 API 配置中输入 API Key", "error");
            elements.apiConfig.open = true;
            return;
          }
          if (!text) {
            updateStatus("请输入要合成的文本", "error");
            return;
          }

          const maxRetries = 2;
          const statusMessage = retryCount > 0 ? 
            \`正在重试生成语音... (第\${retryCount + 1}次尝试)\` : 
            (isStream ? "正在生成流式语音..." : "正在生成语音...");
          
          updateStatus(statusMessage, "info", true);
          elements.audioPlayer.style.display = "none";
          elements.audioPlayer.src = "";

          try {
            const requestBody = {
              model: elements.voice.value, input: text,
              speed: parseFloat(elements.speed.value), pitch: parseFloat(elements.pitch.value), stream: isStream,
              cleaning_options: {
                remove_markdown: elements.removeMarkdown.checked, remove_emoji: elements.removeEmoji.checked,
                remove_urls: elements.removeUrls.checked, remove_line_breaks: elements.removeLineBreaks.checked,
                remove_citation_numbers: elements.removeCitation.checked, custom_keywords: elements.customKeywords.value,
              },
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时

            const response = await fetch(\`\${elements.baseUrl.value}/v1/audio/speech\`, {
              method: "POST",
              headers: { "Authorization": \`Bearer \` + apiKey, "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({ error: { message: \`服务器错误: \${response.statusText}\` } }));
              throw new Error(errorData.error.message);
            }

            if (isStream) {
              const mediaSource = new MediaSource();
              elements.audioPlayer.src = URL.createObjectURL(mediaSource);
              elements.audioPlayer.style.display = "block";
              elements.audioPlayer.play().catch(e => {});
              
              mediaSource.addEventListener("sourceopen", () => {
                const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
                const reader = response.body.getReader();
                
                const pump = () => {
                  reader.read().then(({ done, value }) => {
                    if (done) {
                      if (!sourceBuffer.updating) mediaSource.endOfStream();
                      updateStatus("流式播放完毕！", "success");
                      return;
                    }
                    const append = () => sourceBuffer.appendBuffer(value);
                    if (sourceBuffer.updating) {
                      sourceBuffer.addEventListener("updateend", append, { once: true });
                    } else {
                      append();
                    }
                  });
                };
                sourceBuffer.addEventListener("updateend", pump);
                pump();
              }, { once: true });
            } else {
              const blob = await response.blob();
              const audioUrl = URL.createObjectURL(blob);
              elements.audioPlayer.src = audioUrl;
              elements.audioPlayer.style.display = "block";
              elements.audioPlayer.play();
              updateStatus("语音生成成功！", "success");
              
              // Save to history if checkbox is checked
              if (elements.saveToHistory.checked) {
                await saveToHistory(requestBody, blob);
              }
            }

          } catch (error) {
            console.error('Speech generation error:', error);
            
            // 检查是否应该重试
            const shouldRetry = retryCount < maxRetries && (
              error.name === 'AbortError' || 
              error.message.includes('Failed to get endpoint') ||
              error.message.includes('502') ||
              error.message.includes('503') ||
              error.message.includes('timeout')
            );
            
            if (shouldRetry) {
              console.log(\`Retrying speech generation, attempt \${retryCount + 1}\`);
              setTimeout(() => {
                generateSpeech(isStream, retryCount + 1);
              }, 2000 * (retryCount + 1)); // 递增延迟
            } else {
              let errorMessage = error.message;
              if (error.name === 'AbortError') {
                errorMessage = '请求超时，请检查网络连接后重试';
              } else if (errorMessage.includes('Failed to get endpoint')) {
                errorMessage = 'TTS 服务暂时不可用，请稍后重试';
              }
              updateStatus(\`错误: \${errorMessage}\`, "error", true);
            }
          }
        };

        // Convert ArrayBuffer to Base64 safely
        const arrayBufferToBase64 = async (buffer) => {
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const chunkSize = 8192;
          
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.slice(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
          }
          
          return btoa(binary);
        };

        // Save to history function
        const saveToHistory = async (requestBody, audioBlob) => {
          try {
            updateStatus("正在保存到历史记录...", "info", true);
            
            // Create FormData to send binary data directly
            const formData = new FormData();
            formData.append('text', requestBody.input);
            formData.append('voice', requestBody.model);
            formData.append('speed', requestBody.speed.toString());
            formData.append('pitch', requestBody.pitch.toString());
            formData.append('cleaningOptions', JSON.stringify(requestBody.cleaning_options));
            formData.append('audioFile', audioBlob, 'audio.mp3');
            
            const response = await fetch('/api/save', {
              method: 'POST',
              body: formData  // No Content-Type header needed for FormData
            });
            
            if (response.ok) {
              const result = await response.json();
              updateStatus(\`已保存！分享链接: \${window.location.origin}\${result.shareUrl}\`, "success");
            } else {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error?.message || '保存失败');
            }
          } catch (error) {
            updateStatus(\`保存失败: \${error.message}\`, "error");
          }
        };

        // Event listeners
        elements.btnGenerate.addEventListener("click", () => generateSpeech(false));
        elements.btnStream.addEventListener("click", () => generateSpeech(true));
        elements.btnHistory.addEventListener("click", () => {
          window.open('/history', '_blank');
        });
        elements.copyCurl.addEventListener("click", () => {
          navigator.clipboard.writeText(elements.curlCode.textContent).then(() => {
            elements.copyCurl.textContent = "已复制!";
            setTimeout(() => elements.copyCurl.textContent = "复制", 2000);
          });
        });
        elements.inputText.addEventListener("input", () => { 
          elements.charCount.textContent = \`\${elements.inputText.value.length} 字符\`;
          updateCurlExample();
        });
        elements.clearText.addEventListener("click", () => { 
          elements.inputText.value = ""; 
          elements.charCount.textContent = "0 字符"; 
        });
        const updateUI = () => {
          elements.speedValue.textContent = parseFloat(elements.speed.value).toFixed(2);
          elements.pitchValue.textContent = parseFloat(elements.pitch.value).toFixed(2);
          updateCurlExample();
        };
        ['speed', 'voice', 'apiKey'].forEach(id => elements[id].addEventListener('input', updateUI));
        ['pitch'].forEach(id => elements[id].addEventListener('input', () => elements.pitchValue.textContent = parseFloat(elements.pitch.value).toFixed(2)));


        // Initial page setup
        elements.baseUrl.value = window.location.origin;
        const savedApiKey = getCookie("apiKey");
        if (savedApiKey) {
            elements.apiKey.value = savedApiKey;
            elements.apiConfig.open = false;
        } else {
            elements.apiConfig.open = true;
        }
        elements.charCount.textContent = \`\${elements.inputText.value.length} 字符\`;
        updateUI();
      });
    </script>
  </body>
</html>`;
}
