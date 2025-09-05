const encoder = new TextEncoder();
let expiredAt = null;
let endpoint = null;
let clientId = "76a75279-2ffa-4c3d-8db8-7b47252aa41c";

const API_KEY = globalThis.API_KEY;

// 添加缓存和预刷新机制
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60; // 提前5分钟刷新token
let tokenInfo = {
  endpoint: null,
  token: null,
  expiredAt: null,
};

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  // 只在设置了 API_KEY 的情况下才验证
  if (API_KEY) {
    const authHeader = request.headers.get("authorization");
    const apiKey = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (apiKey !== API_KEY) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Invalid API key. Use 'Authorization: Bearer your-api-key' header",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            ...makeCORSHeaders(),
          },
        }
      );
    }
  }

  const requestUrl = new URL(request.url);
  const path = requestUrl.pathname;

  if (path === "/v1/audio/speech") {
    try {
      const requestBody = await request.json();
      const {
        model = "tts-1",
        input,
        voice = "zh-CN-XiaoxiaoNeural",
        response_format = "mp3",
        speed = 1.0,
        pitch = 1.0, // 添加 pitch 参数，默认值为 0
        style = "general", //添加style参数，默认值为general
      } = requestBody;

      const rate = ((speed - 1) * 100).toFixed(0);
      const numPitch = ((pitch - 1) * 100).toFixed(0); // 将 pitch 参数转换为百分比形式
      const response = await getVoice(
        input,
        voice,
        rate,
        numPitch,
        style,
        "audio-24khz-48kbitrate-mono-mp3",
        false
      );

      return response;
    } catch (error) {
      console.error("Error:", error);
      return new Response(
        JSON.stringify({
          error: {
            message: error.message,
            type: "api_error",
            param: null,
            code: "edge_tts_error",
          },
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...makeCORSHeaders(),
          },
        }
      );
    }
  }

  // 默认返回 404
  return new Response("Not Found", { status: 404 });
}

async function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...makeCORSHeaders(),
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") ||
        "Authorization",
    },
  });
}

async function getVoice(
  text,
  voiceName = "zh-CN-XiaoxiaoNeural",
  rate = 0,
  pitch = 0,
  style = "general",
  outputFormat = "audio-24khz-48kbitrate-mono-mp3",
  download = false
) {
  try {
    const maxChunkSize = 2000; // 假设每次请求的最大文本长度为2000字符
    const chunks = [];

    // 将长文本分段
    for (let i = 0; i < text.length; i += maxChunkSize) {
      const chunk = text.slice(i, i + maxChunkSize);
      chunks.push(chunk);
    }

    // 获取每个分段的音频
    const audioChunks = await Promise.all(
      chunks.map((chunk) =>
        getAudioChunk(chunk, voiceName, rate, pitch, style, outputFormat)
      )
    );

    // 将音频片段拼接起来
    const concatenatedAudio = new Blob(audioChunks, { type: "audio/mpeg" });
    const response = new Response(concatenatedAudio, {
      headers: {
        "Content-Type": "audio/mpeg",
        ...makeCORSHeaders(),
      },
    });

    if (download) {
      response.headers.set(
        "Content-Disposition",
        `attachment; filename="${uuid()}.mp3"`
      );
    }

    return response;
  } catch (error) {
    console.error("语音合成失败:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: error.message,
          type: "api_error",
          param: null,
          code: "edge_tts_error",
        },
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...makeCORSHeaders(),
        },
      }
    );
  }
}

// 优化 getVoice 函数
// async function getVoice(text, voiceName = "zh-CN-XiaoxiaoNeural", rate = 0, pitch = 0,style="general", outputFormat = "audio-24khz-48kbitrate-mono-mp3", download = false) {
//     try {
//         const endpoint = await getEndpoint();
//         const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

//         const response = await fetch(url, {
//             method: "POST",
//             headers: {
//                 "Authorization": endpoint.t,
//                 "Content-Type": "application/ssml+xml",
//                 "User-Agent": "okhttp/4.5.0",
//                 "X-Microsoft-OutputFormat": outputFormat
//             },
//             body: getSsml(text, voiceName, rate, pitch,style)
//         });

//         if (!response.ok) {
//             const errorText = await response.text();
//             throw new Error(`Edge TTS API error: ${response.status} ${errorText}`);
//         }

//         let newResponse = new Response(response.body, response);
//         if (download) {
//             newResponse.headers.set("Content-Disposition", `attachment; filename="${uuid()}.mp3"`);
//         }
//         return addCORSHeaders(newResponse);

//     } catch (error) {
//         console.error("语音合成失败:", error);
//         return new Response(JSON.stringify({
//             error: {
//                 message: error.message,
//                 type: "api_error",
//                 param: null,
//                 code: "edge_tts_error"
//             }
//         }), {
//             status: 500,
//             headers: {
//                 "Content-Type": "application/json",
//                 ...makeCORSHeaders()
//             }
//         });
//     }
// }

//获取单个音频数据
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: endpoint.t,
      "Content-Type": "application/ssml+xml",
      "User-Agent": "okhttp/4.5.0",
      "X-Microsoft-OutputFormat": outputFormat,
    },
    body: getSsml(text, voiceName, rate, pitch, style),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge TTS API error: ${response.status} ${errorText}`);
  }

  return response.blob();
}

function getSsml(text, voiceName, rate, pitch, style) {
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> 
                <voice name="${voiceName}"> 
                    <mstts:express-as style="${style}"  styledegree="1.0" role="default" > 
                        <prosody rate="${rate}%" pitch="${pitch}%" volume="50">${text}</prosody> 
                    </mstts:express-as> 
                </voice> 
            </speak>`;
}

// 优化 getEndpoint 函数
async function getEndpoint() {
  const now = Date.now() / 1000;

  // 检查token是否有效（提前5分钟刷新）
  if (
    tokenInfo.token &&
    tokenInfo.expiredAt &&
    now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY
  ) {
    console.log(
      `使用缓存的token，剩余 ${((tokenInfo.expiredAt - now) / 60).toFixed(
        1
      )} 分钟`
    );
    return tokenInfo.endpoint;
  }

  // 获取新token
  const endpointUrl =
    "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const clientId = crypto.randomUUID().replace(/-/g, "");

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
      throw new Error(`获取endpoint失败: ${response.status}`);
    }

    const data = await response.json();
    const jwt = data.t.split(".")[1];
    const decodedJwt = JSON.parse(atob(jwt));

    // 更新缓存
    tokenInfo = {
      endpoint: data,
      token: data.t,
      expiredAt: decodedJwt.exp,
    };

    console.log(
      `获取新token成功，有效期 ${((decodedJwt.exp - now) / 60).toFixed(1)} 分钟`
    );
    return data;
  } catch (error) {
    console.error("获取endpoint失败:", error);
    // 如果有缓存的token，即使过期也尝试使用
    if (tokenInfo.token) {
      console.log("使用过期的缓存token");
      return tokenInfo.endpoint;
    }
    throw error;
  }
}

function addCORSHeaders(response) {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(makeCORSHeaders())) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, { ...response, headers: newHeaders });
}

function makeCORSHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // 可以将 "*" 替换为特定的来源，例如 "https://9a17e592.text2voice.pages.dev"
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Max-Age": "86400", // 允许OPTIONS请求预检缓存的时间
  };
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
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function bytesToBase64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}

function uuid() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function sign(urlStr) {
  const url = urlStr.split("://")[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = uuid();
  const formattedDate = dateFormat();
  const bytesToSign =
    `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
  const decode = await base64ToBytes(
    "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=="
  );
  const signData = await hmacSha256(decode, bytesToSign);
  const signBase64 = await bytesToBase64(signData);
  return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
  const formattedDate =
    new Date().toUTCString().replace(/GMT/, "").trim() + " GMT";
  return formattedDate.toLowerCase();
}

// 添加请求超时控制
async function fetchWithTimeout(url, options, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}
