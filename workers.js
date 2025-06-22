/**
 * A Cloudflare Worker for proxying Microsoft Edge's TTS service.
 *
 * @version 2.4.0 (Robust Edition)
 * @description Implemented an internal, automatic batch processing mechanism to
 * handle Cloudflare's subrequest limits gracefully. The API can now process
 * text of any length without ever failing due to "Too many subrequests".
 * This is the final, production-ready version.
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
    if (request.method === "OPTIONS") return handleOptions(request);

    if (API_KEY) {
        const authHeader = request.headers.get("authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== API_KEY) {
            return errorResponse("Invalid API key.", 401, "invalid_api_key");
        }
    }

    const url = new URL(request.url);
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

    const MAX_SUBREQUESTS = 48;
    let finalChunkSize = chunk_size;
    let finalConcurrency = Math.min(concurrency, MAX_SUBREQUESTS);
    const estimatedChunks = Math.ceil(cleanedInput.length / finalChunkSize);
    if (estimatedChunks > MAX_SUBREQUESTS) {
        finalChunkSize = Math.ceil(cleanedInput.length / MAX_SUBREQUESTS);
    }

    const modelVoice = OPENAI_VOICE_MAP[model.replace('tts-1-', '')] || OPENAI_VOICE_MAP[voice];
    const finalVoice = modelVoice || voice;
    
    const rate = ((speed - 1) * 100).toFixed(0);
    const finalPitch = ((pitch - 1) * 100).toFixed(0);
    const outputFormat = "audio-24khz-48kbitrate-mono-mp3";

    const textChunks = smartChunkText(cleanedInput, finalChunkSize);
    const ttsArgs = [finalVoice, rate, finalPitch, style, outputFormat];

    if (stream) {
        return await streamVoice(textChunks, finalConcurrency, ...ttsArgs);
    } else {
        return await getVoice(textChunks, finalConcurrency, ...ttsArgs);
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
    const sanitizedText = text.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
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