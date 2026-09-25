/**
 * Claude Messages API <-> OpenAI Chat Completions adapter.
 *
 * The Claude and OpenAI schemas are deliberately not treated as aliases.  The
 * adapter keeps Claude's client-facing contract (content blocks, thinking
 * blocks, tool results, usage, and the SSE event sequence) and translates only
 * the fields that have a meaningful Chat Completions/OpenRouter equivalent.
 *
 * References used for the wire contract:
 * - Anthropic SDK: src/resources/messages/messages.ts
 *   https://github.com/anthropics/anthropic-sdk-typescript
 * - OpenAI Chat Completions types:
 *   https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts
 * - OpenRouter reasoning details:
 *   https://openrouter.ai/docs/use-cases/reasoning-tokens
 */

import { createParser } from 'eventsource-parser';

// ─── Native Messages detection and stream observation ───────────────

/**
 * OpenRouter exposes an Anthropic-compatible `/messages` endpoint (and
 * Anthropic itself is natively compatible). Native mode is important: a
 * Chat Completions conversion cannot preserve Claude thinking signatures,
 * server tools, citations, or context-management edits.
 */
export function usesNativeMessages(channel) {
  if (channel.messages_mode === 'native') return true;
  if (channel.messages_mode === 'chat') return false;
  try {
    const url = new URL(channel.base_url);
    const pathname = url.pathname.replace(/\/+$/, '');
    return pathname.endsWith('/messages') ||
      (url.hostname === 'openrouter.ai' && pathname === '/api/v1') ||
      (url.hostname === 'api.anthropic.com' && pathname === '/v1');
  } catch {
    return false;
  }
}

/** Observe a native Claude SSE stream without changing a single event. */
export function observeClaudeStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let usage = null;
  let settle;
  let ended = false;
  const usagePromise = new Promise((resolve) => { settle = resolve; });
  const parser = createParser({
    maxBufferSize: 8 * 1024 * 1024,
    onEvent(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message_start' && data.message?.usage) {
          usage = {
            ...(usage || {}),
            input_tokens: data.message.usage.input_tokens || 0,
            output_tokens: data.message.usage.output_tokens || 0,
          };
        }
        if (data.type === 'message_delta' && data.usage) {
          usage = {
            ...(usage || { input_tokens: 0, output_tokens: 0 }),
            input_tokens: data.usage.input_tokens ?? usage?.input_tokens ?? 0,
            output_tokens: data.usage.output_tokens ?? usage?.output_tokens ?? 0,
          };
        }
      } catch {}
    },
  });
  function finish() {
    if (ended) return;
    ended = true;
    settle(usage);
    try { reader.releaseLock(); } catch {}
  }
  const stream = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          try { parser.feed(decoder.decode()); } catch {}
          finish();
          ctrl.close();
          return;
        }
        try { parser.feed(decoder.decode(value, { stream: true })); } catch {}
        ctrl.enqueue(value);
      } catch (error) {
        finish();
        ctrl.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finish(); }
    },
  });
  return { stream, usagePromise };
}

// ─── Request conversion ─────────────────────────────────────────────

/**
 * Convert a Claude Messages request to OpenAI Chat Completions.
 *
 * `options.openRouter` enables OpenRouter's documented extensions:
 * `reasoning: { effort|max_tokens }`, `reasoning_details`, and
 * `cache_control`.  It is intentionally opt-in because those fields are not
 * part of the portable OpenAI schema.
 */
export function claudeToOpenAI(claude, options = {}) {
  if (!claude || typeof claude !== 'object') {
    throw new Error('Claude request body must be an object');
  }

  assertPortableFeatures(claude);

  const openRouter = !!options.openRouter;
  const openai = {
    model: claude.model,
    messages: convertMessages(claude.system, claude.messages, { openRouter }),
    stream: !!claude.stream,
  };

  copyDefined(openai, 'max_tokens', claude.max_tokens);
  copyDefined(openai, 'temperature', claude.temperature);
  copyDefined(openai, 'top_p', claude.top_p);
  copyDefined(openai, 'stop', claude.stop_sequences);
  copyDefined(openai, 'user', claude.metadata?.user_id);
  copyDefined(openai, 'service_tier', mapServiceTier(claude.service_tier));

  // top_k is deprecated by recent Claude models, but older Claude requests
  // can still contain it.  OpenRouter accepts it as an OpenAI-compatible
  // sampling extension; do not send it to strict OpenAI-compatible servers.
  if (claude.top_k !== undefined && (openRouter || options.allowTopK)) {
    openai.top_k = claude.top_k;
  }

  const reasoning = mapReasoning(claude, openRouter);
  if (reasoning) {
    if (reasoning.openRouter) openai.reasoning = reasoning.value;
    else Object.assign(openai, reasoning.value);
  }

  const responseFormat = mapOutputFormat(claude.output_config || (claude.output_format ? { format: claude.output_format } : null));
  if (responseFormat) openai.response_format = responseFormat;

  const toolResult = mapToolChoice(claude.tool_choice);
  if (toolResult.choice !== undefined) openai.tool_choice = toolResult.choice;
  if (toolResult.parallel !== undefined) openai.parallel_tool_calls = toolResult.parallel;

  const tools = convertTools(claude.tools, { openRouter });
  if (tools.length > 0) openai.tools = tools;

  // Anthropic's top-level cache_control means "put a breakpoint on the last
  // cacheable block".  There is no portable Chat Completions equivalent, so
  // only translate it when the caller explicitly selected OpenRouter.
  if (openRouter && claude.cache_control) {
    // OpenRouter accepts Anthropic's top-level automatic cache marker on
    // Chat Completions; keep it at the request level as well as exposing
    // explicit block markers supplied by the client.
    openai.cache_control = claude.cache_control;
    applyCacheControlToLastBlock(openai.messages);
  }

  return openai;
}

function assertPortableFeatures(claude) {
  const unsupported = [];
  if (Array.isArray(claude.context_management?.edits) && claude.context_management.edits.length > 0) {
    unsupported.push('context_management.edits');
  }
  if (claude.compaction) unsupported.push('compaction');
  if (Array.isArray(claude.mcp_servers) && claude.mcp_servers.length > 0) unsupported.push('mcp_servers');
  if (claude.fallbacks) unsupported.push('fallbacks');
  if (claude.container !== undefined && claude.container !== null) unsupported.push('container');
  if (claude.speed === 'fast') unsupported.push('speed=fast');
  if (unsupported.length > 0) {
    throw new Error(`Claude feature(s) ${unsupported.join(', ')} require a native Messages upstream`);
  }
}

function copyDefined(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function mapServiceTier(value) {
  if (value === undefined || value === null) return undefined;
  // Claude's standard_only means "do not use priority".  Chat Completions
  // calls that tier "default".
  if (value === 'standard_only') return 'default';
  return value;
}

function mapReasoning(claude, openRouter) {
  const effort = claude.output_config?.effort;
  const thinking = claude.thinking;

  // output_config.effort takes precedence over legacy budget-based thinking.
  // This is also the precedence documented by OpenRouter for unified
  // reasoning requests.
  if (effort !== undefined && effort !== null) {
    return openRouter
      ? { openRouter: true, value: { effort } }
      : { value: { reasoning_effort: effort } };
  }

  if (!thinking || typeof thinking !== 'object') return null;

  if (thinking.type === 'disabled') {
    if (openRouter) return { openRouter: true, value: { effort: 'none' } };
    return { value: { reasoning_effort: 'none' } };
  }

  if (thinking.type === 'adaptive') {
    if (openRouter) return { openRouter: true, value: { enabled: true } };
    throw new Error('adaptive thinking requires a native Messages or OpenRouter reasoning target');
  }

  if (thinking.type === 'enabled' && Number.isFinite(thinking.budget_tokens)) {
    if (openRouter) {
      return { openRouter: true, value: { max_tokens: thinking.budget_tokens } };
    }
    throw new Error('budget-based thinking requires a native Messages or OpenRouter reasoning target');
  }

  return null;
}

function mapOutputFormat(outputConfig) {
  const format = outputConfig?.format;
  if (!format || format.type !== 'json_schema' || !format.schema) return null;
  return {
    type: 'json_schema',
    json_schema: {
      name: 'claude_output',
      // Anthropic's format does not carry OpenAI's strict flag. Leave the
      // portable default false unless a caller supplied an explicit one.
      strict: false,
      schema: sanitizeSchema(format.schema),
    },
  };
}

function mapToolChoice(choice) {
  if (choice === undefined || choice === null) return {};

  if (typeof choice === 'string') return { choice };
  if (!choice || typeof choice !== 'object') return {};

  const parallel = choice.disable_parallel_tool_use === true
    ? false
    : choice.disable_parallel_tool_use === false
      ? true
      : undefined;

  switch (choice.type) {
    case 'auto':
      return { choice: 'auto', parallel };
    case 'any':
      return { choice: 'required', parallel };
    case 'none':
      return { choice: 'none', parallel };
    case 'tool':
      return choice.name
        ? { choice: { type: 'function', function: { name: choice.name } }, parallel }
        : { parallel };
    default:
      return { parallel };
  }
}

function convertTools(tools, { openRouter }) {
  if (!Array.isArray(tools)) return [];
  const converted = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;

    // Claude server tools (web_search, code execution, text editor, etc.) are
    // executed by Anthropic, not by a Chat Completions client.  Silently
    // dropping them would make the model believe they are available, so fail
    // explicitly when one is requested.
    if (tool.type && tool.type !== 'custom') {
      throw new Error(`Claude server tool type "${tool.type}" cannot be executed through Chat Completions`);
    }

    if (!tool.name) continue;
    converted.push({
      type: 'function',
      ...(openRouter && tool.cache_control ? { cache_control: tool.cache_control } : {}),
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: sanitizeSchema(tool.input_schema || { type: 'object' }),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    });
  }

  return converted;
}

function convertMessages(system, claudeMessages, { openRouter }) {
  const messages = [];

  if (system !== undefined && system !== null) {
    const systemMessage = {
      role: 'system',
      content: convertSystemContent(system, openRouter),
    };
    if (openRouter && system?.cache_control) {
      applyCacheControlToLastBlock([systemMessage]);
    }
    messages.push(systemMessage);
  }

  if (!Array.isArray(claudeMessages)) return messages;

  for (const message of claudeMessages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';

    if (typeof message.content === 'string') {
      messages.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    if (role === 'assistant') {
      const assistant = convertAssistantContent(message.content, openRouter);
      if (assistant) messages.push(assistant);
      continue;
    }

    // Tool results must precede any ordinary user content in Chat
    // Completions.  This is required when a Claude user turn contains both a
    // tool_result block and a text block.
    const toolMessages = [];
    const followupParts = [];
    const userParts = [];
    for (const block of message.content) {
      if (block?.type === 'tool_result') {
        const convertedResult = convertToolResultContent(block.content, block.is_error);
        toolMessages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: convertedResult.text,
        });
        followupParts.push(...convertedResult.followupParts);
        continue;
      }
      const part = convertContentBlock(block, openRouter);
      if (part) userParts.push(part);
    }
    messages.push(...toolMessages);
    if (followupParts.length > 0) {
      messages.push({ role: 'user', content: followupParts });
    }
    if (userParts.length > 0) {
      messages.push({ role, content: collapseTextParts(userParts) });
    }
  }

  return messages;
}

function convertSystemContent(system, openRouter) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  const parts = [];
  for (const block of system) {
    if (!block) continue;
    if (block.type === 'text') {
      const part = { type: 'text', text: block.text || '' };
      if (openRouter && block.cache_control) part.cache_control = block.cache_control;
      parts.push(part);
    }
  }
  return collapseTextParts(parts);
}

function convertAssistantContent(blocks, openRouter) {
  const parts = [];
  const toolCalls = [];
  const reasoningDetails = [];
  let reasoningText = '';

  for (const block of blocks) {
    switch (block?.type) {
      case 'text': {
        const part = { type: 'text', text: block.text || '' };
        if (openRouter && block.cache_control) part.cache_control = block.cache_control;
        parts.push(part);
        break;
      }
      case 'image': {
        const part = convertImageBlock(block, openRouter);
        if (part) parts.push(part);
        break;
      }
      case 'document': {
        const part = convertDocumentBlock(block, openRouter);
        if (part) parts.push(part);
        break;
      }
      case 'thinking': {
        reasoningText += block.thinking || '';
        if (openRouter) {
          reasoningDetails.push({
            type: 'reasoning.text',
            text: block.thinking || '',
            signature: block.signature ?? null,
            format: 'anthropic-claude-v1',
          });
        }
        break;
      }
      case 'redacted_thinking': {
        if (openRouter) {
          reasoningDetails.push({
            type: 'reasoning.encrypted',
            data: block.data || '',
            format: 'anthropic-claude-v1',
          });
        } else {
          parts.push({ type: 'text', text: '[redacted thinking]' });
        }
        break;
      }
      case 'tool_use': {
        if (!block.id || !block.name) continue;
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;
      }
      default:
        // Server-tool result blocks are not valid assistant content for a
        // portable Chat Completions request. Keep a visible marker rather
        // than silently changing the conversation.
        if (block && typeof block === 'object') {
          parts.push({ type: 'text', text: JSON.stringify(block) });
        }
    }
  }

  const message = { role: 'assistant', content: collapseTextParts(parts) };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (openRouter && reasoningDetails.length > 0) message.reasoning_details = reasoningDetails;
  if (!openRouter && reasoningText) message.reasoning_content = reasoningText;

  if (!message.content && !message.tool_calls && !message.reasoning_details && !message.reasoning_content) {
    return null;
  }
  return message;
}

function convertContentBlock(block, openRouter) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text': {
      const part = { type: 'text', text: block.text || '' };
      if (openRouter && block.cache_control) part.cache_control = block.cache_control;
      return part;
    }
    case 'image':
      return convertImageBlock(block, openRouter);
    case 'document':
      return convertDocumentBlock(block, openRouter);
    case 'search_result':
      return { type: 'text', text: JSON.stringify(block) };
    default:
      return null;
  }
}

function convertImageBlock(block, openRouter) {
  const source = block?.source;
  if (!source) return null;
  if (source.type === 'url' && source.url) {
    const part = { type: 'image_url', image_url: { url: source.url } };
    if (openRouter && block.cache_control) part.cache_control = block.cache_control;
    return part;
  }
  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || 'image/png';
    const part = {
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${source.data}` },
    };
    if (openRouter && block.cache_control) part.cache_control = block.cache_control;
    return part;
  }
  if (source.type === 'file' && source.file_id) {
    return { type: 'text', text: `[image file_id=${source.file_id}]` };
  }
  return null;
}

function convertDocumentBlock(block, openRouter) {
  const source = block?.source;
  if (!source) return null;

  if (source.type === 'text' && source.data !== undefined) {
    return { type: 'text', text: String(source.data) };
  }
  if (source.type === 'url' && source.url) {
    const part = {
      type: 'file',
      file: { file_data: source.url, filename: block.title || 'document' },
    };
    if (openRouter && block.cache_control) part.cache_control = block.cache_control;
    return part;
  }
  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || 'application/pdf';
    const part = {
      type: 'file',
      file: {
        file_data: `data:${mediaType};base64,${source.data}`,
        filename: block.title || 'document',
      },
    };
    if (openRouter && block.cache_control) part.cache_control = block.cache_control;
    return part;
  }
  if (source.type === 'text' && source.content !== undefined) {
    return { type: 'text', text: JSON.stringify(source.content) };
  }
  return { type: 'text', text: JSON.stringify(block) };
}

function convertToolResultContent(content, isError) {
  const textParts = [];
  const followupParts = [];
  if (typeof content === 'string' || content === undefined || content === null) {
    textParts.push(content ?? '');
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        textParts.push(String(part ?? ''));
      } else if (part.type === 'text') {
        textParts.push(part.text || '');
      } else if (part.type === 'image') {
        const converted = convertImageBlock(part, false);
        if (converted?.type === 'image_url') followupParts.push(converted);
        else textParts.push(`[image result: ${JSON.stringify(part.source || {})}]`);
      } else if (part.type === 'document') {
        const converted = convertDocumentBlock(part, false);
        if (converted?.type === 'file') followupParts.push(converted);
        else textParts.push(`[document result: ${JSON.stringify(part.source || {})}]`);
      } else {
        textParts.push(JSON.stringify(part));
      }
    }
  } else {
    textParts.push(JSON.stringify(content));
  }
  let text = textParts.join('\n');
  if (isError) text = `[tool_error] ${text}`;
  return { text, followupParts };
}

function collapseTextParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  if (parts.every((part) => part?.type === 'text')) {
    return parts.map((part) => part.text || '').join('\n');
  }
  return parts;
}

function applyCacheControlToLastBlock(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const content = message?.content;
    if (typeof content === 'string') {
      messages[i] = { ...message, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] };
      return;
    }
    if (Array.isArray(content) && content.length > 0) {
      const last = content[content.length - 1];
      if (last && typeof last === 'object') {
        last.cache_control = { type: 'ephemeral' };
        return;
      }
    }
  }
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    // $schema is a JSON Schema meta-key and is not understood by the
    // OpenAI tool schema validator. Keep all semantic schema keys intact.
    if (key === '$schema') continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
}

// ─── Non-streaming response conversion ─────────────────────────────

/** Convert an OpenAI Chat Completions response to Claude Messages format. */
export function openAIToClaude(openai, model) {
  const response = {
    id: `msg_${rid()}`,
    type: 'message',
    role: 'assistant',
    model: model || openai?.model || 'unknown',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: toClaudeUsage(openai?.usage, openai?.service_tier),
  };

  const choice = openai?.choices?.[0];
  const message = choice?.message || {};

  // OpenRouter exposes structured reasoning in reasoning_details; other
  // OpenAI-compatible servers commonly use reasoning_content or reasoning.
  for (const detail of message.reasoning_details || []) {
    if (detail?.type === 'reasoning.encrypted' || detail?.type === 'reasoning_encrypted') {
      response.content.push({
        type: 'redacted_thinking',
        data: detail.data || detail.encrypted_content || '',
      });
      continue;
    }
    const text = detail?.text || detail?.summary || detail?.content;
    if (text) {
      response.content.push({
        type: 'thinking',
        thinking: String(text),
        signature: detail.signature || '',
      });
    }
  }
  const plainReasoning = message.reasoning_content || message.reasoning;
  const plainReasoningText = typeof plainReasoning === 'string'
    ? plainReasoning
    : plainReasoning?.text || plainReasoning?.content || '';
  if (plainReasoningText && !message.reasoning_details?.length) {
    response.content.push({
      type: 'thinking',
      thinking: String(plainReasoningText),
      signature: '',
    });
  }

  for (const part of contentParts(message.content)) {
    if (part.type === 'text' && part.text !== undefined) {
      response.content.push({ type: 'text', text: String(part.text), citations: null });
    } else if (part.type === 'refusal' && part.refusal !== undefined) {
      response.content.push({ type: 'text', text: String(part.refusal), citations: null });
      response.stop_details = { type: 'refusal', category: null, explanation: String(part.refusal) };
    }
  }

  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || toolCall;
    if (!fn?.name) continue;
    response.content.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${rid()}`,
      name: fn.name,
      input: safeParse(fn.arguments ?? fn.input ?? '{}'),
    });
  }

  if ((message.tool_calls || []).length > 0) {
    response.stop_reason = 'tool_use';
  } else if (choice?.finish_reason === 'length') {
    response.stop_reason = 'max_tokens';
  } else if (choice?.finish_reason === 'content_filter' || response.stop_details) {
    response.stop_reason = 'refusal';
  } else {
    response.stop_reason = 'end_turn';
  }

  return response;
}

function contentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part && (part.type === 'text' || part.type === 'refusal'));
}

function toClaudeUsage(usage, serviceTier) {
  const source = usage || {};
  const promptDetails = source.prompt_tokens_details || {};
  const completionDetails = source.completion_tokens_details || {};
  const reasoningTokens = Number.isFinite(completionDetails.reasoning_tokens)
    ? completionDetails.reasoning_tokens
    : Number.isFinite(source.reasoning_tokens) ? source.reasoning_tokens : 0;

  return {
    input_tokens: source.prompt_tokens ?? 0,
    output_tokens: source.completion_tokens ?? 0,
    cache_creation_input_tokens: promptDetails.cache_creation_tokens ?? 0,
    cache_read_input_tokens: promptDetails.cached_tokens ?? 0,
    cache_creation: null,
    output_tokens_details: { thinking_tokens: reasoningTokens },
    server_tool_use: null,
    service_tier: serviceTier || null,
  };
}

// ─── Streaming response conversion ─────────────────────────────────

/**
 * Transform an OpenAI Chat Completions SSE stream into Anthropic Messages SSE.
 * The event names and block lifecycle follow Anthropic's MessageStream contract.
 */
export function openAIStreamToClaudeStream(body, model) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const messageId = `msg_${rid()}`;
  let buffer = '';
  let nextBlockIndex = 0;
  let textIndex = -1;
  let thinkingIndex = -1;
  let thinkingSignature = null;
  let toolBlocks = new Map();
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let messageDeltaSent = false;
  let pendingFinishReason = null;
  let stopSent = false;

  function send(ctrl, event, data) {
    // Anthropic Messages SSE events do not have Responses-style
    // sequence_number fields; keep the native event payload exact.
    ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify({ ...data, type: event })}\n\n`));
  }

  function startText(ctrl) {
    if (textIndex >= 0) return;
    textIndex = nextBlockIndex++;
    send(ctrl, 'content_block_start', {
      index: textIndex,
      content_block: { type: 'text', text: '', citations: null },
    });
  }

  function startThinking(ctrl) {
    if (thinkingIndex >= 0) return;
    thinkingIndex = nextBlockIndex++;
    thinkingSignature = null;
    send(ctrl, 'content_block_start', {
      index: thinkingIndex,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
  }

  function closeBlock(ctrl, index, type) {
    if (index < 0) return;
    if (type === 'thinking' && thinkingSignature) {
      send(ctrl, 'content_block_delta', {
        index,
        delta: { type: 'signature_delta', signature: thinkingSignature },
      });
    }
    send(ctrl, 'content_block_stop', { index });
  }

  function closeText(ctrl) {
    if (textIndex < 0) return;
    closeBlock(ctrl, textIndex, 'text');
    textIndex = -1;
  }

  function closeThinking(ctrl) {
    if (thinkingIndex < 0) return;
    closeBlock(ctrl, thinkingIndex, 'thinking');
    thinkingIndex = -1;
    thinkingSignature = null;
  }

  function closeTool(ctrl, state) {
    if (!state || state.closed || state.index < 0) return;
    state.closed = true;
    closeBlock(ctrl, state.index, 'tool_use');
  }

  function closeAll(ctrl) {
    // Anthropic sends signature_delta immediately before the thinking block
    // stop, so close reasoning before ordinary text blocks.
    closeThinking(ctrl);
    closeText(ctrl);
    for (const state of toolBlocks.values()) closeTool(ctrl, state);
  }

  function updateUsage(chunkUsage) {
    if (!chunkUsage) return;
    if (Number.isFinite(chunkUsage.prompt_tokens)) usage.prompt_tokens = chunkUsage.prompt_tokens;
    if (Number.isFinite(chunkUsage.completion_tokens)) usage.completion_tokens = chunkUsage.completion_tokens;
    if (chunkUsage.prompt_tokens_details) {
      usage.prompt_tokens_details = chunkUsage.prompt_tokens_details;
    }
    if (chunkUsage.completion_tokens_details) {
      usage.completion_tokens_details = chunkUsage.completion_tokens_details;
    }
  }

  function addThinkingText(ctrl, text, signature) {
    if (!text) return;
    startThinking(ctrl);
    if (signature !== undefined && signature !== null) thinkingSignature = signature;
    send(ctrl, 'content_block_delta', {
      index: thinkingIndex,
      delta: { type: 'thinking_delta', thinking: String(text) },
    });
  }

  function addReasoningDetails(ctrl, details) {
    if (!Array.isArray(details)) return false;
    let handled = false;
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue;
      handled = true;
      if (detail.type === 'reasoning.encrypted' || detail.type === 'reasoning_encrypted') {
        const index = nextBlockIndex++;
        send(ctrl, 'content_block_start', {
          index,
          content_block: { type: 'redacted_thinking', data: detail.data || detail.encrypted_content || '' },
        });
        send(ctrl, 'content_block_stop', { index });
      } else {
        addThinkingText(ctrl, detail.text || detail.summary || detail.content, detail.signature);
      }
    }
    return handled;
  }

  function addToolCall(ctrl, toolCall) {
    if (!toolCall || typeof toolCall !== 'object') return;
    const index = toolCall.index ?? 0;
    let state = toolBlocks.get(index);
    const fn = toolCall.function || toolCall;
    const id = toolCall.id || fn.id || `toolu_${rid()}`;
    const name = fn.name;

    if (!state) {
      // Do not emit an invalid Claude block until a name is available. Some
      // compatible servers send the id first and the name in a later chunk.
      state = { id, name: '', index: -1, arguments: '' };
      toolBlocks.set(index, state);
    }
    if (name) state.name = name;
    if (fn.arguments !== undefined) state.arguments += fn.arguments || '';

    if (state.index < 0 && state.name) {
      state.index = nextBlockIndex++;
      send(ctrl, 'content_block_start', {
        index: state.index,
        content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
      });
    }
    if (state.index >= 0 && fn.arguments) {
      send(ctrl, 'content_block_delta', {
        index: state.index,
        delta: { type: 'input_json_delta', partial_json: fn.arguments },
      });
    }
  }

  function finish(ctrl, finishReason) {
    if (messageDeltaSent || pendingFinishReason !== null) return;
    // Chat providers commonly put finish_reason before the usage-only chunk.
    // Close blocks now, but defer message_delta until EOF so Claude receives
    // cumulative usage from that final chunk.
    pendingFinishReason = finishReason || 'stop';
    closeAll(ctrl);
  }

  function finalize(ctrl) {
    if (messageDeltaSent) return;
    const finishReason = pendingFinishReason || 'stop';
    let stopReason = 'end_turn';
    if (finishReason === 'tool_calls' || finishReason === 'function_call' || toolBlocks.size > 0) {
      stopReason = 'tool_use';
    } else if (finishReason === 'length') {
      stopReason = 'max_tokens';
    } else if (finishReason === 'content_filter') {
      stopReason = 'refusal';
    }
    send(ctrl, 'message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: usage.prompt_tokens ?? null,
        output_tokens: usage.completion_tokens ?? 0,
        cache_creation_input_tokens: usage.prompt_tokens_details?.cache_creation_tokens ?? null,
        cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? null,
        output_tokens_details: usage.completion_tokens_details || null,
        server_tool_use: null,
      },
    });
    messageDeltaSent = true;
  }

  return new ReadableStream({
    async start(ctrl) {
      const reader = body.getReader();
      send(ctrl, 'message_start', {
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: model || 'unknown',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          container: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
          },
        },
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            for (const line of part.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const json = trimmed.slice(5).trim();
              if (!json || json === '[DONE]') continue;
              let data;
              try { data = JSON.parse(json); } catch { continue; }

              if (data.error) {
                send(ctrl, 'error', {
                  error: { type: 'api_error', message: data.error.message || String(data.error) },
                });
                continue;
              }
              updateUsage(data.usage);
              if (!Array.isArray(data.choices) || data.choices.length === 0) continue;
              const choice = data.choices[0];
              const delta = choice.delta || {};

              const detailsHandled = addReasoningDetails(ctrl, delta.reasoning_details);
              if (!detailsHandled) {
                const reasoning = delta.reasoning_content ?? delta.reasoning_text ?? delta.reasoning;
                const reasoningText = typeof reasoning === 'string'
                  ? reasoning
                  : reasoning?.text || reasoning?.content || '';
                if (reasoningText) addThinkingText(ctrl, reasoningText, null);
              }

              const text = extractText(delta.content);
              if (text) {
                startText(ctrl);
                send(ctrl, 'content_block_delta', {
                  index: textIndex,
                  delta: { type: 'text_delta', text },
                });
              }
              if (delta.refusal) {
                startText(ctrl);
                send(ctrl, 'content_block_delta', {
                  index: textIndex,
                  delta: { type: 'text_delta', text: String(delta.refusal) },
                });
              }

              if (Array.isArray(delta.tool_calls)) {
                for (const toolCall of delta.tool_calls) addToolCall(ctrl, toolCall);
              } else if (delta.function_call) {
                addToolCall(ctrl, { index: 0, id: 'toolu_legacy', function: delta.function_call });
              }

              if (choice.finish_reason) finish(ctrl, choice.finish_reason);
            }
          }
        }
        finalize(ctrl);
      } catch (error) {
        if (!messageDeltaSent) {
          send(ctrl, 'error', {
            error: { type: 'api_error', message: error instanceof Error ? error.message : String(error) },
          });
          finalize(ctrl);
        }
      } finally {
        if (!stopSent) {
          closeAll(ctrl);
          finalize(ctrl);
          send(ctrl, 'message_stop', {});
          stopSent = true;
        }
        try { reader.releaseLock(); } catch {}
        ctrl.close();
      }
    },
  });
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' || part?.type === 'output_text' || part?.type === 'refusal')
    .map((part) => part.text || part.refusal || '')
    .join('');
}

// ─── Helpers ────────────────────────────────────────────────────────

function rid() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
}

function safeParse(value) {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}
