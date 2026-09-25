import { verifyApiKey } from './auth.js';
import { LoadBalancer } from '../lb/balancer.js';
import { claudeToOpenAI, openAIToClaude, openAIStreamToClaudeStream, usesNativeMessages, observeClaudeStream } from './claude.js';
import { responsesToChatCompletions, getCustomToolNames, chatCompletionsToResponses, chatCompletionsStreamToResponsesStream, usesNativeResponses, observeResponsesStream } from './responses.js';

export async function handleProxy(request, env, store) {
  // Verify client API key
  const authResult = await verifyApiKey(request, store);
  if (!authResult.valid) {
    return jsonRes({
      error: { message: authResult.error, type: 'invalid_request_error' }
    }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname;

  const allowedChannelIds = authResult.apiKey.channel_ids || null;
  const clientKeyId = authResult.apiKey.id;

  // GET /v1/models
  if (path.endsWith('/models') && request.method === 'GET') {
    return handleModels(store, allowedChannelIds);
  }

  // Only POST for completions / embeddings / messages
  if (request.method !== 'POST') {
    return jsonRes({ error: { message: 'Method not allowed' } }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: { message: 'Invalid JSON body' } }, 400);
  }

  // ---- Claude Messages API (including count_tokens) ----
  if (path.endsWith('/messages/count_tokens')) {
    return handleClaudeCountTokens(request, url, body, store, allowedChannelIds, clientKeyId);
  }
  if (path.endsWith('/messages')) {
    return handleClaudeMessages(request, url, body, store, allowedChannelIds, clientKeyId);
  }

  // ---- OpenAI Responses API (/v1/responses) ----
  if (path.endsWith('/responses')) {
    return handleResponses(request, url, body, store, allowedChannelIds, clientKeyId);
  }

  // ---- OpenAI-compatible passthrough ----
  return handleOpenAIProxy(request, url, path, body, store, allowedChannelIds, clientKeyId);
}

// ─── Claude Messages API handler ───────────────────────────────────

async function handleClaudeCountTokens(request, url, claudeBody, store, allowedChannelIds) {
  if (!claudeBody || typeof claudeBody.model !== 'string' || !claudeBody.model.trim()) {
    return claudeErrorRes('model is required', 400);
  }
  const model = claudeBody.model;
  const lb = new LoadBalancer(store);
  const { targets, error } = await lb.selectTarget(model, allowedChannelIds);
  if (error || targets.length === 0) {
    return claudeErrorRes(error || 'No available channel for model: ' + model, 503);
  }

  for (const target of targets) {
    try {
      const baseUrl = target.channel.base_url.replace(/\/+$/, '');
      const native = usesNativeMessages(target.channel);
      const targetUrl = baseUrl + (native ? '/messages/count_tokens' : '/chat/completions');
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (native && new URL(target.channel.base_url).hostname === 'api.anthropic.com') {
        headers.set('x-api-key', target.key);
      } else {
        headers.set('Authorization', `Bearer ${target.key}`);
      }
      if (native) headers.set('anthropic-version', request.headers.get('anthropic-version') || '2023-06-01');
      const anthropicBeta = request.headers.get('anthropic-beta');
      if (native && anthropicBeta) headers.set('anthropic-beta', anthropicBeta);
      copyForwardHeaders(request.headers, headers, CLAUDE_FORWARD_HEADERS);

      if (native) {
        const resp = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(claudeBody) });
        const text = await resp.text();
        return new Response(text, {
          status: resp.status,
          headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // There is no portable Chat Completions token-count endpoint.  This
      // deterministic estimate is only used for non-native upstreams; native
      // Anthropic/OpenRouter targets above return the provider's exact count.
      const converted = claudeToOpenAI(claudeBody);
      const serialized = JSON.stringify({ messages: converted.messages, tools: converted.tools || [] });
      const inputTokens = Math.max(1, Math.ceil(serialized.length / 4));
      return jsonRes({ input_tokens: inputTokens });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return claudeErrorRes(message, 502);
    }
  }
  return claudeErrorRes('No available channel for model: ' + model, 503);
}

async function handleClaudeMessages(request, url, claudeBody, store, allowedChannelIds, clientKeyId) {
  if (!claudeBody || typeof claudeBody.model !== 'string' || !claudeBody.model.trim()) {
    return claudeErrorRes('model is required', 400);
  }
  const model = claudeBody.model;
  const isStream = claudeBody.stream || false;

  // Conversion is target-specific. Native Messages upstreams (notably
  // OpenRouter) must receive the original body so signatures and beta fields
  // are not lost; Chat targets are converted below.
  let baseOpenaiBody;
  let baseConversionError = null;
  try {
    baseOpenaiBody = claudeToOpenAI(claudeBody);
  } catch (error) {
    baseConversionError = error instanceof Error ? error.message : String(error);
  }

  const lb = new LoadBalancer(store);
  const { targets, error } = await lb.selectTarget(model, allowedChannelIds);

  if (error || targets.length === 0) {
    // Return error in Claude format
    return claudeErrorRes(error || 'No available channel for model: ' + model, 503);
  }

  const MAX_429_ROUNDS = 2;
  let lastError = null;
  let last429Body = '';

  for (let round = 0; round < MAX_429_ROUNDS; round++) {
    if (round > 0) {
      console.log(`[proxy][claude] all targets returned 429, retry round ${round + 1} after delay`);
      await sleep(3000 * round);
    }
    let consecutive429 = 0;

    for (const target of targets) {
      try {
        const baseUrl = target.channel.base_url.replace(/\/+$/, '');
        const nativeMessages = usesNativeMessages(target.channel);
        const targetUrl = baseUrl + (nativeMessages ? '/messages' : '/chat/completions') + url.search;
        let openaiBody = null;
        if (!nativeMessages) {
          if (baseConversionError) {
            return claudeErrorRes(baseConversionError, 400);
          }
          openaiBody = isOpenRouterChannel(target.channel)
            ? claudeToOpenAI(claudeBody, { openRouter: true })
            : { ...baseOpenaiBody };
          if (isStream) openaiBody.stream_options = { include_usage: true };
        }

        console.log(`[proxy][claude] -> ${target.channel.name} ${targetUrl}${round > 0 ? ` (retry #${round})` : ''}`);

        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        if (nativeMessages && new URL(target.channel.base_url).hostname === 'api.anthropic.com') {
          headers.set('x-api-key', target.key);
        } else {
          headers.set('Authorization', `Bearer ${target.key}`);
        }
        if (nativeMessages) {
          headers.set('anthropic-version', request.headers.get('anthropic-version') || '2023-06-01');
        }
        const anthropicBeta = request.headers.get('anthropic-beta');
        if (nativeMessages && anthropicBeta) headers.set('anthropic-beta', anthropicBeta);
        copyForwardHeaders(request.headers, headers, CLAUDE_FORWARD_HEADERS);
        if (isStream) headers.set('Accept', 'text/event-stream');

        const resp = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: nativeMessages ? JSON.stringify(claudeBody) : JSON.stringify(openaiBody),
        });
        const rateHeaders = extractRateLimitHeaders(resp.headers);
        if (rateHeaders.hasAny) {
          store.updateRateLimitHeaders(target.channel.id, target.key, model, rateHeaders).catch(e =>
            console.error('[ratelimit] update headers failed:', e)
          );
        }

        if (resp.status === 404) {
          lastError = `HTTP 404 (model not found)`;
          logError(store, target, model, 404, lastError);
          continue;
        }

        if (resp.status === 429) {
          consecutive429++;
          try { last429Body = await resp.text(); } catch { last429Body = ''; }
          lastError = `HTTP 429 (rate limited)`;
          const rlReason = await classifyAndRecord429(store, target, model, resp, rateHeaders);
          logError(store, target, model, 429, `${lastError}${rlReason ? `: ${rlReason}` : ''}`);
          await sleep(calc429Delay(rateHeaders, consecutive429));
          continue;
        }

        if (resp.ok || resp.status < 500) {
          if (!resp.ok) {
            const errBody = await resp.text();
            logError(store, target, model, resp.status, errBody);
            if (nativeMessages) {
              return new Response(errBody, {
                status: resp.status,
                headers: responseHeaders(resp.headers),
              });
            }
            return claudeErrorRes(`Upstream error: ${errBody}`, resp.status);
          }

          // 上游返回 SSE 流时才走流式处理；某些上游在异常情况下即使收到
          // stream:true 也会返回普通 JSON（choices:null），此时走非流式验证路径
          const upstreamIsSSE = isStream &&
            (resp.headers.get('Content-Type') || '').includes('text/event-stream');

          if (upstreamIsSSE) {
            store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
            // 渠道用量立即记录（仅计数）
            store.incrementUsage(target.channel.id, target.key, model).catch(e =>
              console.error('[usage] increment failed:', e));

            const observed = nativeMessages
              ? observeClaudeStream(resp.body)
              : (() => {
                  const processed = processStream(resp.body);
                  return {
                    stream: openAIStreamToClaudeStream(processed.stream, model),
                    usagePromise: processed.usagePromise,
                  };
                })();
            const claudeStream = observed.stream;

            // 流结束后异步记录 API 密钥用量（含 token 数）
            observed.usagePromise.then(usage => {
              const pt = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
              const ct = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
              store.incrementApiKeyUsage(clientKeyId, model, pt, ct).catch(e =>
                console.error('[apikey-usage] increment failed:', e));
            }).catch(() => {
              store.incrementApiKeyUsage(clientKeyId, model, 0, 0).catch(() => {});
            });

            return new Response(claudeStream, {
              status: 200,
              headers: responseHeaders(resp.headers, true),
            });
          }

          // 非流式 或 上游未返回 SSE 时（可能是异常 JSON），验证 choices 字段
          if (isStream) {
            console.warn(`[proxy][claude] 上游对 stream:true 返回了非 SSE 响应 (Content-Type: ${resp.headers.get('Content-Type')}), 回退到非流式验证`);
          }
          const openaiData = await resp.json();
          if (nativeMessages) {
            store.incrementUsage(target.channel.id, target.key, model).catch(e =>
              console.error('[usage] increment failed:', e));
            const usage = openaiData.usage || {};
            store.incrementApiKeyUsage(clientKeyId, model,
              usage.input_tokens ?? usage.prompt_tokens ?? 0,
              usage.output_tokens ?? usage.completion_tokens ?? 0).catch(e =>
                console.error('[apikey-usage] increment failed:', e));
            store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
            return new Response(JSON.stringify(openaiData), {
              status: 200,
              headers: responseHeaders(resp.headers),
            });
          }
          if (!Array.isArray(openaiData.choices)) {
            lastError = `upstream returned invalid response (choices=${openaiData.choices})`;
            logError(store, target, model, 200, lastError);
            continue;
          }

          // 非流式：从响应中提取 token 用量
          const pt = openaiData.usage?.prompt_tokens || 0;
          const ct = openaiData.usage?.completion_tokens || 0;
          store.incrementUsage(target.channel.id, target.key, model).catch(e =>
            console.error('[usage] increment failed:', e));
          store.incrementApiKeyUsage(clientKeyId, model, pt, ct).catch(e =>
            console.error('[apikey-usage] increment failed:', e));

          const claudeResponse = openAIToClaude(openaiData, model);
          store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
          return new Response(JSON.stringify(claudeResponse), {
            status: 200,
            headers: responseHeaders(resp.headers),
          });
        }

        lastError = `HTTP ${resp.status}`;
        logError(store, target, model, resp.status, lastError);
      } catch (err) {
        lastError = err.message;
        logError(store, target, model, 0, lastError);
      }
    }

    if (consecutive429 === 0 || consecutive429 < targets.length) break;
  }

  const detail = last429Body ? ` | upstream: ${last429Body.slice(0, 200)}` : '';
  return claudeErrorRes(`All targets failed. Last error: ${lastError}${detail}`, 502);
}

// ─── OpenAI Responses API handler ──────────────────────────────────

async function handleResponses(request, url, body, store, allowedChannelIds, clientKeyId) {
  if (!body || typeof body.model !== 'string' || !body.model.trim()) {
    return responsesErrorRes('model is required', 400);
  }
  const model = body.model;
  const isStream = body.stream || false;

  let baseOpenaiBody;
  let baseConversionError = null;
  try {
    // Build a fallback for Chat-only targets, but do not reject a request
    // merely because a native Responses target can handle stateful/hosted
    // features that the fallback cannot represent.
    baseOpenaiBody = responsesToChatCompletions(body);
  } catch (error) {
    baseConversionError = error instanceof Error ? error.message : String(error);
  }

  const lb = new LoadBalancer(store);
  const { targets, error } = await lb.selectTarget(model, allowedChannelIds);

  if (error || targets.length === 0) {
    return responsesErrorRes(error || 'No available channel for model: ' + model, 503);
  }

  const MAX_429_ROUNDS = 2;
  let lastError = null;
  let last429Body = '';

  for (let round = 0; round < MAX_429_ROUNDS; round++) {
    if (round > 0) {
      console.log(`[proxy][responses] all targets returned 429, retry round ${round + 1} after delay`);
      await sleep(3000 * round);
    }
    let consecutive429 = 0;

    for (const target of targets) {
      try {
        const baseUrl = target.channel.base_url.replace(/\/+$/, '');
        const isNative = usesNativeResponses(target.channel);
        if (!isNative && baseConversionError) {
          return responsesErrorRes(baseConversionError, 400);
        }
        let openaiBody = null;
        if (!isNative) {
          openaiBody = isOpenRouterChannel(target.channel)
            ? responsesToChatCompletions(body, { openRouter: true })
            : { ...baseOpenaiBody };
          if (!isOpenRouterChannel(target.channel)) {
            Object.defineProperty(openaiBody, '__customToolNames', {
              value: getCustomToolNames(baseOpenaiBody),
              enumerable: false,
            });
          }
        }
        if (!isNative && isStream) {
          openaiBody.stream_options = {
            ...(openaiBody.stream_options || {}),
            include_usage: true,
          };
        }
        const targetUrl = isNative
          ? baseUrl + '/responses' + url.search
          : baseUrl + '/chat/completions' + url.search;

        console.log(`[proxy][responses] -> ${target.channel.name} ${targetUrl}${round > 0 ? ` (retry #${round})` : ''}`);

        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        headers.set('Authorization', `Bearer ${target.key}`);
        copyForwardHeaders(request.headers, headers, RESPONSES_FORWARD_HEADERS);
        if (isStream) headers.set('Accept', 'text/event-stream');

        const resp = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: isNative ? JSON.stringify(body) : JSON.stringify(openaiBody),
        });
        const rateHeaders = extractRateLimitHeaders(resp.headers);
        if (rateHeaders.hasAny) {
          store.updateRateLimitHeaders(target.channel.id, target.key, model, rateHeaders).catch(e =>
            console.error('[ratelimit] update headers failed:', e)
          );
        }

        if (resp.status === 404) {
          lastError = `HTTP 404 (model not found)`;
          logError(store, target, model, 404, lastError);
          continue;
        }

        if (resp.status === 429) {
          consecutive429++;
          try { last429Body = await resp.text(); } catch { last429Body = ''; }
          lastError = `HTTP 429 (rate limited)`;
          const rlReason = await classifyAndRecord429(store, target, model, resp, rateHeaders);
          logError(store, target, model, 429, `${lastError}${rlReason ? `: ${rlReason}` : ''}`);
          await sleep(calc429Delay(rateHeaders, consecutive429));
          continue;
        }

        if (resp.ok || resp.status < 500) {
          if (!resp.ok) {
            const errBody = await resp.text();
            logError(store, target, model, resp.status, errBody);
            if (isNative) {
              return new Response(errBody, {
                status: resp.status,
                headers: responseHeaders(resp.headers),
              });
            }
            return responsesErrorRes(`Upstream error: ${errBody}`, resp.status);
          }

          const upstreamIsSSE = isStream &&
            (resp.headers.get('Content-Type') || '').includes('text/event-stream');

          if (upstreamIsSSE) {
            store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
            store.incrementUsage(target.channel.id, target.key, model).catch(e =>
              console.error('[usage] increment failed:', e));

            const observed = isNative
              ? observeResponsesStream(resp.body)
              : chatCompletionsStreamToResponsesStream(resp.body, model, {
                  customToolNames: getCustomToolNames(openaiBody),
                });

            observed.usagePromise.then(usage => {
              const pt = usage?.prompt_tokens || 0;
              const ct = usage?.completion_tokens || 0;
              store.incrementApiKeyUsage(clientKeyId, model, pt, ct).catch(e =>
                console.error('[apikey-usage] increment failed:', e));
            }).catch(() => {
              store.incrementApiKeyUsage(clientKeyId, model, 0, 0).catch(() => {});
            });

            return new Response(observed.stream, {
              status: 200,
              headers: responseHeaders(resp.headers, true),
            });
          }

          if (isStream) {
            console.warn(`[proxy][responses] upstream returned non-SSE for stream:true (Content-Type: ${resp.headers.get('Content-Type')}), falling back to non-streaming`);
          }

          const openaiData = await resp.json();
          if (isNative) {
            store.incrementUsage(target.channel.id, target.key, model).catch(e =>
              console.error('[usage] increment failed:', e));
            const usage = openaiData.usage || {};
            store.incrementApiKeyUsage(clientKeyId, model,
              usage.input_tokens ?? usage.prompt_tokens ?? 0,
              usage.output_tokens ?? usage.completion_tokens ?? 0).catch(e =>
              console.error('[apikey-usage] increment failed:', e));
            store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
            return new Response(JSON.stringify(openaiData), {
              status: 200,
              headers: responseHeaders(resp.headers),
            });
          }
          if (!Array.isArray(openaiData.choices)) {
            lastError = `upstream returned invalid response (choices=${openaiData.choices})`;
            logError(store, target, model, 200, lastError);
            continue;
          }

          const pt = openaiData.usage?.prompt_tokens || 0;
          const ct = openaiData.usage?.completion_tokens || 0;
          store.incrementUsage(target.channel.id, target.key, model).catch(e =>
            console.error('[usage] increment failed:', e));
          store.incrementApiKeyUsage(clientKeyId, model, pt, ct).catch(e =>
            console.error('[apikey-usage] increment failed:', e));

          const responsesData = chatCompletionsToResponses(openaiData, model, {
            customToolNames: getCustomToolNames(openaiBody),
          });
          store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
          return new Response(JSON.stringify(responsesData), {
            status: 200,
            headers: responseHeaders(resp.headers),
          });
        }

        lastError = `HTTP ${resp.status}`;
        logError(store, target, model, resp.status, lastError);
      } catch (err) {
        lastError = err.message;
        logError(store, target, model, 0, lastError);
      }
    }

    if (consecutive429 === 0 || consecutive429 < targets.length) break;
  }

  const detail = last429Body ? ` | upstream: ${last429Body.slice(0, 200)}` : '';
  return responsesErrorRes(`All targets failed. Last error: ${lastError}${detail}`, 502);
}

// ─── OpenAI passthrough handler ────────────────────────────────────

async function handleOpenAIProxy(request, url, path, body, store, allowedChannelIds, clientKeyId) {
  const model = body.model || '';
  const lb = new LoadBalancer(store);
  const { targets, error } = await lb.selectTarget(model, allowedChannelIds);

  if (error || targets.length === 0) {
    return jsonRes({
      error: { message: error || 'No available channel', type: 'server_error' }
    }, 503);
  }

  // Strip /v1 prefix, keep the rest (e.g. /chat/completions)
  const upstreamPath = path.replace(/^\/v1/, '');

  // 参考 one-api：流式请求注入 stream_options，让上游在最后一个 chunk 返回 token 用量
  if (body.stream) {
    if (!body.stream_options) body.stream_options = {};
    body.stream_options.include_usage = true;
  }

  // Try each target in order (failover on 5xx / network error)
  // 429 退避：共享 IP 环境（如 HF Spaces）下上游可能按 IP 限流，
  // 需要在连续 429 之间加入延迟，并支持整轮重试
  const MAX_429_ROUNDS = 2;
  let lastError = null;
  let last429Body = '';

  for (let round = 0; round < MAX_429_ROUNDS; round++) {
    if (round > 0) {
      console.log(`[proxy] all targets returned 429, retry round ${round + 1} after delay`);
      await sleep(3000 * round);
    }
    let consecutive429 = 0;

    for (const target of targets) {
      try {
        const baseUrl = target.channel.base_url.replace(/\/+$/, '');
        const targetUrl = baseUrl + upstreamPath + url.search;

        console.log(`[proxy] -> ${target.channel.name} ${targetUrl}${round > 0 ? ` (retry #${round})` : ''}`);

        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        headers.set('Authorization', `Bearer ${target.key}`);
        copyForwardHeaders(request.headers, headers, OPENAI_FORWARD_HEADERS);

        // Forward Accept header (important for streaming)
        const accept = request.headers.get('Accept');
        if (accept) headers.set('Accept', accept);

        const resp = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const rateHeaders = extractRateLimitHeaders(resp.headers);
        if (rateHeaders.hasAny) {
          store.updateRateLimitHeaders(target.channel.id, target.key, model, rateHeaders).catch(e =>
            console.error('[ratelimit] update headers failed:', e)
          );
        }

        if (resp.status === 404) {
          lastError = `HTTP 404 (model not found)`;
          logError(store, target, model, 404, lastError);
          continue;
        }

        if (resp.status === 429) {
          consecutive429++;
          try { last429Body = await resp.text(); } catch { last429Body = ''; }
          lastError = `HTTP 429 (rate limited)`;
          const rlReason = await classifyAndRecord429(store, target, model, resp, rateHeaders);
          logError(store, target, model, 429, `${lastError}${rlReason ? `: ${rlReason}` : ''}`);
          await sleep(calc429Delay(rateHeaders, consecutive429));
          continue;
        }

        if (resp.ok || resp.status < 500) {
          if (!resp.ok) {
            logError(store, target, model, resp.status, `HTTP ${resp.status}`);
          }

          const respHeaders = new Headers();
          const ct = resp.headers.get('Content-Type');
          if (ct) respHeaders.set('Content-Type', ct);
          respHeaders.set('Access-Control-Allow-Origin', '*');

          // 上游返回 SSE 流时才走流式处理；某些上游在异常情况下即使收到
          // stream:true 也会返回普通 JSON（choices:null），此时走非流式验证路径
          const upstreamIsSSE = body.stream &&
            (ct || '').includes('text/event-stream');

          if (upstreamIsSSE) {
            store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
            // 禁用 nginx 缓冲（HF Spaces 必须），否则代理会缓冲整个流导致 ECONNRESET
            respHeaders.set('Content-Type', 'text/event-stream');
            respHeaders.set('Cache-Control', 'no-cache');
            respHeaders.set('Connection', 'keep-alive');
            respHeaders.set('X-Accel-Buffering', 'no');

            // 处理流：修复 id 字段 + 捕获 usage（参考 one-api 流式 token 统计方案）
            const { stream, usagePromise } = processStream(resp.body);

            if (resp.ok) {
              // 渠道用量立即记录（仅计数）
              store.incrementUsage(target.channel.id, target.key, model).catch(e =>
                console.error('[usage] increment failed:', e));
              // API 密钥用量在流结束后记录（含 token 数）
              usagePromise.then(usage => {
                const pt = usage?.prompt_tokens || 0;
                const ct = usage?.completion_tokens || 0;
                store.incrementApiKeyUsage(clientKeyId, model, pt, ct).catch(e =>
                  console.error('[apikey-usage] increment failed:', e));
              }).catch(() => {
                store.incrementApiKeyUsage(clientKeyId, model, 0, 0).catch(() => {});
              });
            }

            return new Response(stream, { status: resp.status, headers: respHeaders });
          }

          // 上游对 stream:true 返回了非 SSE 响应，回退到非流式验证
          if (body.stream) {
            console.warn(`[proxy] 上游对 stream:true 返回了非 SSE 响应 (Content-Type: ${ct}), 回退到非流式验证`);
          }

          // Non-streaming: validate chat/completions responses
          if (resp.ok && upstreamPath.includes('/chat/completions')) {
            const respText = await resp.text();
            let promptTokens = 0, completionTokens = 0;
            try {
              const data = JSON.parse(respText);
              if (!Array.isArray(data.choices)) {
                lastError = `upstream returned invalid response (choices=${data.choices})`;
                logError(store, target, model, 200, lastError);
                continue;
              }
              promptTokens = data.usage?.prompt_tokens || 0;
              completionTokens = data.usage?.completion_tokens || 0;
            } catch { /* not valid JSON — pass through as-is */ }
            // 非流式：记录请求次数和 token 用量
            store.incrementUsage(target.channel.id, target.key, model).catch(e =>
              console.error('[usage] increment failed:', e));
            store.incrementApiKeyUsage(clientKeyId, model, promptTokens, completionTokens).catch(e =>
              console.error('[apikey-usage] increment failed:', e));
            store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
            return new Response(respText, { status: resp.status, headers: respHeaders });
          }

          // 其他非流式路径（embeddings 等）
          if (resp.ok) {
            store.incrementUsage(target.channel.id, target.key, model).catch(e =>
              console.error('[usage] increment failed:', e));
            store.incrementApiKeyUsage(clientKeyId, model, 0, 0).catch(e =>
              console.error('[apikey-usage] increment failed:', e));
            store.clearRateLimitCooldown(target.channel.id, target.key, model).catch(() => {});
          }

          return new Response(resp.body, { status: resp.status, headers: respHeaders });
        }

        lastError = `HTTP ${resp.status}`;
        logError(store, target, model, resp.status, lastError);
      } catch (err) {
        lastError = err.message;
        logError(store, target, model, 0, lastError);
      }
    }

    // Only retry if all failures in this round were 429
    if (consecutive429 === 0 || consecutive429 < targets.length) break;
  }

  const detail = last429Body ? ` | upstream: ${last429Body.slice(0, 200)}` : '';
  return jsonRes({
    error: {
      message: `All targets failed. Last error: ${lastError}${detail}`,
      type: 'server_error',
    }
  }, 502);
}

async function handleModels(store, allowedChannelIds) {
  const channels = await store.getChannels();
  let enabled = channels.filter(ch => ch.enabled);
  if (allowedChannelIds && allowedChannelIds.length > 0) {
    enabled = enabled.filter(ch => allowedChannelIds.includes(ch.id));
  }

  // Collect models: use configured list if available, otherwise fetch from upstream
  const allModels = []; // { id, owned_by }

  const fetchPromises = enabled.map(async (ch) => {
    const configuredModels = Array.isArray(ch.models) ? ch.models : [];
    if (!ch.keys?.length) {
      return configuredModels.map(m => ({ id: m, owned_by: ch.name }));
    }

    const baseUrl = ch.base_url.replace(/\/+$/, '');
    try {
      const resp = await fetch(baseUrl + '/models', {
        headers: { 'Authorization': `Bearer ${ch.keys[0]}` },
      });
      if (!resp.ok) {
        return configuredModels.map(m => ({ id: m, owned_by: ch.name }));
      }
      const data = await resp.json();
      if (data?.data && Array.isArray(data.data)) {
        const modelIds = data.data.map(m => m.id);
        store.setModelCache(ch.id, modelIds).catch(e =>
          console.error(`[models] cache write failed for ${ch.name}:`, e)
        );
        const upstreamById = new Map(data.data.map(m => [m.id, m]));
        if (configuredModels.length > 0) {
          return configuredModels.map(id => upstreamById.get(id) || { id, owned_by: ch.name });
        }
        return data.data.map(m => ({
          ...m,
          id: m.id,
          owned_by: m.owned_by || ch.name,
        }));
      }
      return configuredModels.map(m => ({ id: m, owned_by: ch.name }));
    } catch {
      console.error(`[models] Failed to fetch models from ${ch.name}`);
      return configuredModels.map(m => ({ id: m, owned_by: ch.name }));
    }
  });

  const results = await Promise.all(fetchPromises);
  const modelMap = new Map(); // deduplicate by model id
  for (const models of results) {
    for (const m of models) {
      const existing = modelMap.get(m.id);
      if (!existing || (!existing.reasoning && m.reasoning)) {
        modelMap.set(m.id, existing ? { ...existing, ...m, id: m.id } : m);
      }
    }
  }

  return jsonRes({
    object: 'list',
    data: Array.from(modelMap.values()).map(m => normalizePublicModel(m)),
  });
}

function extractRateLimitHeaders(headers) {
  const intOrNull = (v) => {
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const info = {
    user_limit: intOrNull(headers.get('modelscope-ratelimit-requests-limit')),
    user_remaining: intOrNull(headers.get('modelscope-ratelimit-requests-remaining')),
    model_limit: intOrNull(headers.get('modelscope-ratelimit-model-requests-limit')),
    model_remaining: intOrNull(headers.get('modelscope-ratelimit-model-requests-remaining')),
    retry_after: intOrNull(headers.get('retry-after')),
  };
  info.hasAny =
    info.user_limit !== null ||
    info.user_remaining !== null ||
    info.model_limit !== null ||
    info.model_remaining !== null ||
    info.retry_after !== null;
  return info;
}

async function classifyAndRecord429(store, target, model, resp, rateHeaders) {
  let errText = '';
  try { errText = await resp.text(); } catch { errText = ''; }

  let code = '';
  let message = errText;
  try {
    const data = JSON.parse(errText || '{}');
    code = String(data?.error?.code || data?.errors?.code || '').toLowerCase();
    message = String(data?.error?.message || data?.errors?.message || errText || '');
  } catch {
    code = '';
  }

  const msg = message.toLowerCase();
  const modelRemaining = Number.isFinite(rateHeaders?.model_remaining) ? rateHeaders.model_remaining : null;
  const userRemaining = Number.isFinite(rateHeaders?.user_remaining) ? rateHeaders.user_remaining : null;

  if ((modelRemaining !== null && modelRemaining <= 0) || (userRemaining !== null && userRemaining <= 0)) {
    await store.markRateLimited(target.channel.id, target.key, model);
    return 'daily quota exhausted';
  }

  const isBurst = code.includes('limit_burst_rate') || msg.includes('increased too quickly');
  const isRequests = code.includes('limit_requests') || msg.includes('rate limit') || msg.includes('rate limited');
  const retryAfterMs = (Number.isFinite(rateHeaders?.retry_after) && rateHeaders.retry_after > 0)
    ? rateHeaders.retry_after * 1000
    : null;
  const cooldownMs = retryAfterMs || (isBurst ? 45 * 1000 : 90 * 1000);

  if (isBurst || isRequests) {
    await store.markRateLimitedTemporary(target.channel.id, target.key, model, cooldownMs);
    return `temporary cooldown ${Math.ceil(cooldownMs / 1000)}s`;
  }

  await store.markRateLimitedTemporary(target.channel.id, target.key, model, 90 * 1000);
  return 'temporary cooldown 90s';
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function logError(store, target, model, status, message) {
  const hint = target.key.length > 12 ? target.key.slice(0, 7) + '...' + target.key.slice(-4) : target.key;
  store.appendError(target.channel.id, {
    model, status, message: String(message).slice(0, 200), key_hint: hint,
  }).catch(e => console.error('[errorlog] write failed:', e));
}

function responsesErrorRes(message, status = 500) {
  return new Response(JSON.stringify({
    id: 'resp_err_' + Date.now(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'failed',
    error: {
      code: status >= 500 ? 'server_error' : 'invalid_request_error',
      message,
    },
    output: [],
    usage: null,
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function claudeErrorRes(message, status = 500) {
  return new Response(JSON.stringify({
    type: 'error',
    error: {
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      message,
    },
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Headers that are safe and meaningful when a client protocol is relayed to
// an upstream protocol. Authentication and hop-by-hop headers are handled
// separately and are never copied from the client.
const CLAUDE_FORWARD_HEADERS = [
  'anthropic-version', 'anthropic-beta', 'x-client-request-id',
  'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os',
  'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version',
  'x-stainless-retry-count', 'x-stainless-timeout',
];
const RESPONSES_FORWARD_HEADERS = [
  'OpenAI-Beta',
  'x-client-request-id', 'x-openai-subagent', 'originator',
  'session-id', 'thread-id', 'x-codex-turn-state',
  'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os',
  'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version',
  'x-stainless-retry-count', 'x-stainless-timeout',
];
const OPENAI_FORWARD_HEADERS = [
  'OpenAI-Beta',
  'x-client-request-id', 'x-openai-subagent', 'originator',
  'session-id', 'thread-id', 'x-codex-turn-state',
];

function copyForwardHeaders(source, target, names) {
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) target.set(name, value);
  }
}

function responseHeaders(upstream, streaming = false) {
  const headers = new Headers();
  const contentType = upstream.get('Content-Type');
  headers.set('Content-Type', contentType || (streaming ? 'text/event-stream' : 'application/json'));
  for (const name of [
    'x-request-id', 'openai-model', 'x-openai-model', 'x-models-etag',
    'x-reasoning-included', 'retry-after',
  ]) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('Access-Control-Allow-Origin', '*');
  if (streaming) {
    headers.set('Cache-Control', 'no-cache');
    headers.set('Connection', 'keep-alive');
    headers.set('X-Accel-Buffering', 'no');
  }
  return headers;
}

function normalizePublicModel(model) {
  const output = {
    id: model.id,
    object: 'model',
    created: model.created || 0,
    owned_by: model.owned_by || 'unknown',
  };
  // Preserve capability metadata when an upstream provides it. This is
  // especially useful for OpenRouter's reasoning object and supported
  // parameters; older OpenAI servers simply omit these fields.
  for (const key of [
    'context_length', 'architecture', 'supported_parameters',
    'default_parameters', 'pricing', 'top_provider', 'reasoning',
  ]) {
    if (model[key] !== undefined) output[key] = model[key];
  }
  return output;
}

function isOpenRouterChannel(channel) {
  try {
    return new URL(channel.base_url).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 429 退避策略：根据 retry-after 头或指数退避计算等待时间。
 * HF Spaces 等共享 IP 环境下，上游(ModelScope)可能按 IP 限流，
 * 需要在 failover 循环中加入延迟避免连续请求全部被拒。
 */
function calc429Delay(rateHeaders, attempt) {
  if (rateHeaders?.retry_after > 0) {
    return rateHeaders.retry_after * 1000;
  }
  return Math.min(2000 * Math.pow(1.5, attempt), 15000);
}

/**
 * 处理 SSE 流：修复 id 字段 + 捕获 usage（参考 one-api 流式 token 统计方案）。
 *
 * 功能：
 * 1. 修复上游返回 id: null 的问题（国内模型如 GLM 不遵循 OpenAI 规范）
 * 2. 配合 stream_options.include_usage=true，从最后一个 chunk 捕获 token 用量
 *
 * 返回 { stream, usagePromise }：
 * - stream: 修复后的 ReadableStream，可直接返回给客户端
 * - usagePromise: 流结束后 resolve 为 { prompt_tokens, completion_tokens } 或 null
 */
function processStream(body) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  let capturedUsage = null;
  let resolveUsage;
  const usagePromise = new Promise(resolve => { resolveUsage = resolve; });

  const stream = body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            const data = JSON.parse(trimmed.slice(6));
            // 过滤掉 choices 为 null 的无效 chunk（国内 API 常见异常）
            if ('choices' in data && !Array.isArray(data.choices)) {
              if (data.usage) {
                // A final usage-only chunk is a valid Chat Completions SSE
                // chunk. Preserve it so the protocol converters can put the
                // cumulative usage in their terminal event.
                capturedUsage = data.usage;
                ctrl.enqueue(enc.encode('data: ' + JSON.stringify(data) + '\n\n'));
              }
              // Other choices:null chunks are provider-specific noise.
              continue;
            }
            if (typeof data.id !== 'string') {
              data.id = data.id != null ? String(data.id) : ('chatcmpl-' + Date.now());
            }
            // 捕获 usage（stream_options.include_usage=true 时上游在末尾 chunk 返回）
            if (data.usage) {
              capturedUsage = data.usage;
            }
            ctrl.enqueue(enc.encode('data: ' + JSON.stringify(data) + '\n\n'));
            continue;
          } catch { /* JSON 解析失败，原样透传 */ }
        }
        ctrl.enqueue(enc.encode(part + '\n\n'));
      }
    },
    flush(ctrl) {
      if (buf.trim()) ctrl.enqueue(enc.encode(buf));
      resolveUsage(capturedUsage);
    },
  }));

  return { stream, usagePromise };
}
