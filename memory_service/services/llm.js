// =================================================================
// LLM 调用统一适配器 + Embedding + API使用统计
// =================================================================

const axios = require('axios');
const { ProxyAgent } = require('undici');
const { get_encoding } = require('tiktoken');
const { getDb } = require('../database');
const { fillPrompt } = require('./nameResolver');

function fillLlmPayload(value) {
    if (typeof value === 'string') return fillPrompt(value);
    if (Array.isArray(value)) return value.map(fillLlmPayload);
    if (value && typeof value === 'object') {
        const next = { ...value };
        if (typeof next.text === 'string') next.text = fillPrompt(next.text);
        if (Array.isArray(next.parts)) next.parts = next.parts.map(fillLlmPayload);
        if (typeof next.content === 'string') next.content = fillPrompt(next.content);
        return next;
    }
    return value;
}

// 后台 LLM 并发控制：最多 1 个同时调用，防止后台任务叠罗汉刷爆 API 限流
let _llmBusy = false;
const _llmQueue = [];
function _llmAcquire() {
    return new Promise(resolve => {
        if (!_llmBusy) { _llmBusy = true; resolve(); }
        else { _llmQueue.push(resolve); }
    });
}
function _llmRelease() {
    if (_llmQueue.length > 0) { const next = _llmQueue.shift(); next(); }
    else { _llmBusy = false; }
}

// 连接超时重试：代理/中转偶尔抽风，给第二次机会
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fetch(url, options);
        } catch (err) {
            const retryableCodes = ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
                                     'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
                                     'ECONNRESET', 'ECONNREFUSED'];
            const isRetryable = err.message?.includes('ConnectTimeout') ||
                              err.message?.includes('Timeout') ||
                              retryableCodes.includes(err.cause?.code);
            if (attempt < maxRetries && isRetryable) {
                const reasonMap = {
                    UND_ERR_SOCKET: '连接被重置',
                    UND_ERR_HEADERS_TIMEOUT: '响应头超时',
                    UND_ERR_BODY_TIMEOUT: '响应体超时',
                    ECONNRESET: 'TLS握手被远端重置',
                    ECONNREFUSED: '远端拒绝连接',
                };
                const reason = reasonMap[err.cause?.code] || '连接超时';
                console.warn(`[fetch] ${reason}，${2 * (attempt + 1)}s后重试 (${attempt + 1}/${maxRetries})…`);
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                continue;
            }
            throw err;
        }
    }
}
const { encryption } = require('../encryption');
const { getShanghaiTime } = require('../utils/time');

const enc = get_encoding('cl100k_base');

// 国内直连；海外优先 HTTPS_PROXY/HTTP_PROXY；本地 Gemini 才回退 7890（云上不写死）
const DOMESTIC_DOMAINS = ['api.deepseek.com', 'dashscope.aliyuncs.com', 'api.dzzi.ai'];
const DOMESTIC_IPS = ['162.14.124.108'];
const _proxyAgents = new Map();

function envProxyUrl() {
    return (
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        ''
    ).trim();
}

function isLocalDev() {
    const env = (process.env.TIDAL_ENV || '').trim().toLowerCase();
    if (['prod', 'production', 'cloud'].includes(env)) return false;
    const relay = (process.env.RELAY_URL || 'http://127.0.0.1:3011').toLowerCase();
    return relay.includes('127.0.0.1') || relay.includes('localhost');
}

function needsProxy(url) {
    if (!url) return false;
    if (url.includes('127.0.0.1') || url.includes('localhost') || url.includes('192.168')) return false;
    try {
        const host = new URL(url).hostname;
        if (host.endsWith('.cn')) return false;
        if (DOMESTIC_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return false;
        if (DOMESTIC_IPS.includes(host)) return false;
    } catch {}
    return true;
}

function proxyUriForUrl(url) {
    if (!needsProxy(url)) return null;
    const env = envProxyUrl();
    if (env) return env;
    const hay = String(url).toLowerCase();
    const google = hay.includes('gemini') || hay.includes('google') || hay.includes('generativelanguage');
    if (google && isLocalDev()) return 'http://127.0.0.1:7890';
    return null;
}

function dispatcherForUrl(url) {
    const uri = proxyUriForUrl(url);
    if (!uri) return undefined;
    if (!_proxyAgents.has(uri)) {
        _proxyAgents.set(uri, new ProxyAgent({
            uri,
            connections: 8,
            headersTimeout: 120000,
            bodyTimeout: 300000,
            connectTimeout: 30000,
        }));
    }
    return _proxyAgents.get(uri);
}

function axiosProxyOption(url) {
    const uri = proxyUriForUrl(url);
    if (!uri) return false;
    try {
        const u = new URL(uri);
        const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
        return { host: u.hostname, port, protocol: u.protocol.replace(':', '') };
    } catch {
        return false;
    }
}

function getProxyDispatcher() {
    const uri = envProxyUrl() || (isLocalDev() ? 'http://127.0.0.1:7890' : null);
    if (!uri) return undefined;
    return dispatcherForUrl('https://generativelanguage.googleapis.com/');
}

// =================================================================
// 本地 Embedding（通过 chroma_server HTTP API）
// =================================================================

async function getLocalEmbedding(text) {
    const CHROMA_URL = process.env.CHROMA_URL || 'http://127.0.0.1:7707';
    const resp = await fetch(`${CHROMA_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
    });
    const result = await resp.json();
    if (result.embedding) return result.embedding;
    throw new Error(result.error || 'No embedding from chroma server');
}

// =================================================================
// Embedding 配置获取
// =================================================================

function getEmbeddingAPIKey() {
    const db = getDb();
    const config = db.prepare(`
        SELECT api_key, model_name, provider, endpoint 
        FROM api_configs 
        WHERE model_name LIKE '%embedding%'
        AND (provider = 'gemini' OR provider = 'openai_compatible')
        LIMIT 1
    `).get();
    
    if (config) {
        return {
            api_key: encryption.decrypt(config.api_key),
            model_name: config.model_name,
            provider: config.provider,
            endpoint: config.endpoint
        };
    }
    
    return {
        api_key: process.env.GEMINI_API_KEY || process.env.API_KEY,
        model_name: 'gemini-embedding-001',
        provider: 'gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta'
    };
}

// =================================================================
// Embedding 生成
// =================================================================

async function getEmbedding(text, embeddingConfig) {
    try {
        if (!embeddingConfig) {
            const db = getDb();
            const dbConfig = db.prepare(`
                SELECT * FROM api_configs 
                WHERE model_name LIKE '%embedding%' 
                ORDER BY id DESC LIMIT 1
            `).get();
            
            if (dbConfig) {
                embeddingConfig = {
                    api_key: dbConfig.api_key ? encryption.decrypt(dbConfig.api_key) : process.env.GEMINI_API_KEY,
                    endpoint: dbConfig.endpoint,
                    model_name: dbConfig.model_name,
                    provider: dbConfig.provider || 'gemini'
                };
            } else {
                embeddingConfig = {
                    api_key: process.env.GEMINI_API_KEY,
                    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
                    model_name: 'gemini-embedding-001',
                    provider: 'gemini'
                };
            }
        }
        
        const apiKey = embeddingConfig.api_key;
        const modelName = embeddingConfig.model_name;
        const provider = embeddingConfig.provider || 'gemini';
        
        let requestUrl, requestBody, headers;
        
        if (provider === 'gemini') {
            requestUrl = `${embeddingConfig.endpoint}/models/${modelName}:embedContent?key=${apiKey}`;
            requestBody = {
                model: modelName,
                content: { parts: [{ text: text }] }
            };
            headers = { 'Content-Type': 'application/json' };
        } else {
            requestUrl = `${embeddingConfig.endpoint}/embeddings`;
            requestBody = { input: text, model: modelName };
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            };
        }
        
        const dispatcher = dispatcherForUrl(requestUrl);
        const response = await fetchWithRetry(requestUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            ...(dispatcher ? { dispatcher } : {})
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Embedding API error (${response.status}): ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
        
        if (provider === 'gemini') {
            return data.embedding?.values || data.embedding;
        } else {
            return data.data[0].embedding;
        }
        
    } catch (error) {
        console.error('getEmbedding failed:', error);
        throw error;
    }
}

// =================================================================
// LLM 统一调用入口
// =================================================================

async function callLLM(geminiMessages, systemPrompt, tools = null, generationConfig = {}, apiConfigId = null) {
    // 等待并发槽：后台任务排队执行，不叠罗汉
    await _llmAcquire();
    try {
        return await _callLLMImpl(geminiMessages, systemPrompt, tools, generationConfig, apiConfigId);
    } finally {
        _llmRelease();
    }
}

/**
 * 同一槽内并行打多个 LLM（占一次全局锁，内部 Promise.all）。
 * 用于航海日志 + 今日事件线同批双调，避免两次 callLLM 串行排队。
 * @param {Array<{messages:any, systemPrompt?:string, tools?:any, generationConfig?:object, apiConfigId?:any}>} jobs
 */
async function callLLMConcurrent(jobs) {
    const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
    if (!list.length) return [];
    if (list.length === 1) {
        const j = list[0];
        return [await callLLM(
            j.messages,
            j.systemPrompt || '',
            j.tools || null,
            j.generationConfig || {},
            j.apiConfigId ?? null,
        )];
    }
    await _llmAcquire();
    try {
        return await Promise.all(list.map((j) => _callLLMImpl(
            j.messages,
            j.systemPrompt || '',
            j.tools || null,
            j.generationConfig || {},
            j.apiConfigId ?? null,
        )));
    } finally {
        _llmRelease();
    }
}

async function _callLLMImpl(geminiMessages, systemPrompt, tools = null, generationConfig = {}, apiConfigId = null) {
    geminiMessages = fillLlmPayload(geminiMessages);
    if (typeof systemPrompt === 'string') systemPrompt = fillPrompt(systemPrompt);
    const db = getDb();
    
    let apiConfig;
    if (apiConfigId) {
        if (isNaN(apiConfigId)) {
            apiConfig = db.prepare('SELECT * FROM api_configs WHERE name = ?').get(apiConfigId);
        } else {
            apiConfig = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(apiConfigId);
        }
    } else {
        apiConfig = db.prepare('SELECT * FROM api_configs WHERE is_default = 1').get();
    }
    
    if (!apiConfig) {
        throw new Error('未找到有效的API配置');
    }

    let decryptedApiKey = apiConfig.api_key;
    if (apiConfig.api_key && apiConfig.api_key.startsWith('enc:')) {
        try {
            decryptedApiKey = encryption.decrypt(apiConfig.api_key);
        } catch (e) {
            console.error('API Key decryption failed:', e);
            throw new Error('API Key 解密失败，请重新配置连接');
        }
    }
    apiConfig.api_key = decryptedApiKey;

    // 兜底：数据库 Key 为空时回退到环境变量
    if (!apiConfig.api_key) {
        apiConfig.api_key = process.env.DEEPSEEK_API_KEY || process.env.API_KEY || '';
    }
    
    console.log(`callLLM: using ${apiConfig.name} (${apiConfig.provider})`);
    
    if (apiConfig.provider === 'gemini') {
        return await callGeminiAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig);
    } else if (apiConfig.provider === 'openai_compatible') {
        return await callOpenAICompatibleAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig);
    } else {
        throw new Error(`Unsupported provider: ${apiConfig.provider}`);
    }
}

// =================================================================
// Gemini 官方 API
// =================================================================

async function callGeminiAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig) {
    const requestBody = {
        contents: geminiMessages,
        generationConfig: {
            temperature: generationConfig.temperature || 1.0,
            maxOutputTokens: generationConfig.maxOutputTokens || 8192,
            ...generationConfig
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };
    // 空 system 不要带 systemInstruction（部分模型会 400）
    if (systemPrompt && String(systemPrompt).trim()) {
        requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    
    if (tools && apiConfig.supports_tools) {
        requestBody.tools = [{ functionDeclarations: tools.functionDeclarations }];
    }

    const modelToUse = apiConfig.model_name_override || apiConfig.model_name;

    // Thinking 吃光 maxOutputTokens → 空文本。2.5 可 budget=0；3.x 不能关死，用 MINIMAL。
    if (!requestBody.generationConfig.thinkingConfig) {
        const m = String(modelToUse || '');
        if (/gemini-3|3\.\d/.test(m)) {
            requestBody.generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
        } else if (m.includes('2.5') || m.includes('flash-lite')) {
            requestBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
    }

    let baseUrl = apiConfig.endpoint;
    if (!baseUrl || baseUrl.trim() === '') {
        baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/';
    }
    if (!baseUrl.endsWith('/')) baseUrl += '/';
    const url = `${baseUrl}${modelToUse}:generateContent?key=${apiConfig.api_key}`;
    
    const safeUrlLog = url.replace(/key=([^&]+)/, 'key=******');
    console.log(`callGeminiAPI: ${safeUrlLog}`);

    let response;
    try {
        response = await axios.post(url, requestBody, { proxy: axiosProxyOption(url) });
    } catch (error) {
        console.error('callGeminiAPI error:', JSON.stringify(error.response?.data, null, 2));
        throw error;
    }
    
    const candidate = response.data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let reply = '';
    const functionCalls = [];

    for (const part of parts) {
        if (part.text) reply += part.text;
        if (part.functionCall) {
            functionCalls.push({
                name: part.functionCall.name,
                args: part.functionCall.args,
                originalPart: part
            });
        }
    }

    const usage = {
        inputTokens: response.data?.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.data?.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: response.data?.usageMetadata?.totalTokenCount || 0
    };

    // 诊断空返回：文本为空但有 output tokens → thinking 吃掉预算
    if (!reply && !functionCalls.length && usage.outputTokens > 0) {
        console.warn(`[Gemini] ⚠️ 空文本但消耗${usage.outputTokens} output tokens → thinking 吃掉预算 | finishReason=${candidate?.finishReason} | safetyRatings=${JSON.stringify(candidate?.safetyRatings)}`);
    }

    return {
        reply: reply.trim(),
        functionCalls: functionCalls.length > 0 ? functionCalls : null,
        usage
    };
}

// =================================================================
// OpenAI 兼容 API（反向代理）
// =================================================================

async function callOpenAICompatibleAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig) {
    let url = apiConfig.endpoint;
    if (!url.endsWith('/')) url += '/';
    if (!url.includes('chat/completions')) {
        url += 'chat/completions';
    }

    console.log(`callOpenAICompatibleAPI: ${url}`);

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    
    for (const msg of geminiMessages) {
        const role = msg.role === 'model' ? 'assistant' : 'user';
        
        const toolCalls = msg.parts?.filter(p => p.functionCall);
        const toolResults = msg.parts?.filter(p => p.functionResponse);
        
        if (toolCalls && toolCalls.length > 0) {
            const textPart = msg.parts.find(p => p.text);
            messages.push({
                role: 'assistant',
                content: textPart?.text || null,
                tool_calls: toolCalls.map((p, i) => ({
                    id: `call_${i}`,
                    type: 'function',
                    function: {
                        name: p.functionCall.name,
                        arguments: JSON.stringify(p.functionCall.args)
                    }
                }))
            });
        } else if (toolResults && toolResults.length > 0) {
            for (let i = 0; i < toolResults.length; i++) {
                const p = toolResults[i];
                messages.push({
                    role: 'tool',
                    tool_call_id: p.functionResponse.id || `call_${i}`,
                    content: JSON.stringify(p.functionResponse.response)
                });
            }
        } else {
            const hasImages = msg.parts?.some(p => p.inline_data);
            if (hasImages) {
                const content = [];
                for (const part of msg.parts) {
                    if (part.text) content.push({ type: 'text', text: part.text });
                    else if (part.inline_data) {
                        content.push({
                            type: 'image_url',
                            image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` }
                        });
                    }
                }
                messages.push({ role, content });
            } else {
                let content = '';
                for (const part of msg.parts) {
                    if (part.text) content += part.text;
                }
                if (content) messages.push({ role, content });
            }
        }
    }
    
    const requestBody = {
        model: apiConfig.model_name,
        messages: messages,
        temperature: generationConfig.temperature || 0.7,
        max_tokens: generationConfig.maxOutputTokens || 4000,
    };
    // DeepSeek 用 thinking.disabled 关推理；Google OpenAI 兼容口不认该字段会 400
    const modelLower = apiConfig.model_name?.toLowerCase() || '';
    const isGoogleOpenai = /generativelanguage\.googleapis\.com|\/v1beta\/openai/i.test(url);
    if (!isGoogleOpenai && (modelLower.includes('deepseek') || modelLower.includes('gemini') || modelLower.includes('flash'))) {
        requestBody.thinking = { type: "disabled" };
    }
    // Google 兼容口：不传 reasoning_effort 时 3.x flash-lite 默认会思考，
    // thinking 吃光 max_tokens → choices[0].message.content 空 → 固化「总结生成失败」。
    // 2.5 可 none；3.x 不能关死，用 minimal（与原生 thinkingLevel=MINIMAL 对齐）。
    if (isGoogleOpenai && (modelLower.includes('gemini') || modelLower.includes('flash'))) {
        const effort = generationConfig.reasoning_effort
            || generationConfig.reasoningEffort
            || (/gemini-2\.5|2\.5-flash/.test(modelLower) ? 'none' : 'minimal');
        requestBody.reasoning_effort = effort;
    }

    // OpenRouter Flex 模式：便宜但可能排队
    if (url.includes('openrouter.ai')) {
        requestBody.service_tier = 'flex';
    }
    
    if (tools && apiConfig.supports_tools && tools.functionDeclarations) {
        requestBody.tools = tools.functionDeclarations.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            }
        }));
    }
    
    const axiosConfig = {
        headers: {
            'Authorization': `Bearer ${apiConfig.api_key}`,
            'Content-Type': 'application/json'
        },
        // 与 Gemini 路径一致：不设超时，避免长输出（如 Scribe 4096 token 提取）被 30s 硬超时掐断
        proxy: axiosProxyOption(url)
    };

    let response;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            response = await axios.post(url, requestBody, axiosConfig);
            break;
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ||
                            err.message?.includes('aborted') ||
                            err.message?.includes('ConnectTimeout') || err.message?.includes('Timeout');
            if (attempt < maxRetries && isTimeout) {
                console.warn(`[axios] 连接超时，${2 * (attempt + 1)}s后重试 (${attempt + 1}/${maxRetries})…`);
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                continue;
            }
            const apiErrDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : '无响应体';
            console.error('callOpenAICompatibleAPI error:', err.message, '| 响应:', apiErrDetail);
            throw err;
        }
    }
    
    const choice = response.data.choices?.[0];

    const finishReason = choice?.finish_reason;
    if (finishReason === 'length') {
        console.warn(`[llm] ⚠️ API返回finish_reason=length（输出被截断），model=${apiConfig.model_name}，max_tokens=${requestBody.max_tokens}`);
    }

    let reply = _normalizeOpenaiMessageContent(choice?.message?.content);

    // DeepSeek / 部分兼容口：content 空时读 reasoning_content
    if (!reply && choice?.message?.reasoning_content) {
        reply = String(choice.message.reasoning_content);
    }

    let functionCalls = null;
    
    if (choice?.message?.tool_calls) {
        functionCalls = choice.message.tool_calls.map(tc => ({
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments)
        }));
    }

    const usage = {
        inputTokens: response.data?.usage?.prompt_tokens || 0,
        outputTokens: response.data?.usage?.completion_tokens || 0,
        totalTokens: response.data?.usage?.total_tokens || 0
    };

    if (!reply && !(functionCalls && functionCalls.length)) {
        const msgKeys = choice?.message ? Object.keys(choice.message).join(',') : '-';
        console.warn(
            `[llm] ⚠️ 空 content model=${apiConfig.model_name} finish=${finishReason || '-'} `
            + `in=${usage.inputTokens} out=${usage.outputTokens} `
            + `effort=${requestBody.reasoning_effort || '-'} msgKeys=${msgKeys}`
        );
    }
    
    return {
        reply: reply ? reply.trim() : '',
        functionCalls,
        usage,
    };
}

/** OpenAI content 可能是 string，或 [{type,text}] 数组。 */
function _normalizeOpenaiMessageContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((p) => {
            if (typeof p === 'string') return p;
            if (p && typeof p.text === 'string') return p.text;
            return '';
        }).join('');
    }
    return '';
}

// =================================================================
// API 使用统计记录
// =================================================================

const recordApiUsage = (chatId, inputTokens, outputTokens, modelName, requestType = 'message') => {
    try {
        const db = getDb();
        const totalTokens = inputTokens + outputTokens;
        const stmt = db.prepare(`
            INSERT INTO api_usage_stats 
            (timestamp, api_calls, input_tokens, output_tokens, total_tokens, model_name, chat_id, request_type)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(getShanghaiTime(), inputTokens, outputTokens, totalTokens, modelName, chatId, requestType);
        console.log(`recordApiUsage: ${requestType}, ${inputTokens}+${outputTokens}=${totalTokens} tokens`);
    } catch (error) {
        console.error('recordApiUsage failed:', error);
    }
};

// =================================================================
// 导出 tiktoken encoder（供其他模块使用）
// =================================================================

function getEncoder() {
    return enc;
}

module.exports = {
    callLLM,
    callLLMConcurrent,
    callGeminiAPI,
    callOpenAICompatibleAPI,
    getEmbedding,
    getEmbeddingAPIKey,
    getLocalEmbedding,
    recordApiUsage,
    getEncoder,
    fetchWithRetry,
    getProxyDispatcher,
    needsProxy
};