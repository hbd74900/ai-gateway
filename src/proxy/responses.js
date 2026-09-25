/**
 * OpenAI Responses API <-> Chat Completions adapter.
 *
 * The Responses API is the wire protocol used by the current Codex client.
 * This file keeps the Codex request shape when an upstream has native
 * Responses support, and provides a deliberately explicit Chat fallback for
 * OpenAI-compatible upstreams.
 *
 * References:
 * - OpenAI SDK response types:
 *   https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts
 * - Codex ResponsesApiRequest:
 *   https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs
 * - OpenAI Chat Completions types:
 *   https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts
 */

import { createParser } from 'eventsource-parser';

// ─── Native Responses detection and usage observation ───────────────

export function usesNativeResponses(channel) {
  if (channel.responses_mode === 'native') return true;
  if (channel.responses_mode === 'chat') return false;
  try {
    const url = new URL(channel.base_url);
    const pathname = url.pathname.replace(/\/+$/, '');
    return pathname.endsWith('/responses') ||
      (url.hostname === 'openrouter.ai' && pathname === '/api/v1') ||
      (url.hostname === 'api.openai.com' && pathname === '/v1');
  } catch {
    return false;
  }
}

/**
 * Pass a native Responses SSE stream through unchanged while observing usage.
 * This is intentionally lossless: native reasoning items, encrypted content,
 * custom tools, and event sequence numbers must not be reconstructed.
 */
export function observeResponsesStream(body) {
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
        const value = data.response?.usage || data.usage;
        if (value) {
          // Keep the historical observer contract used by the gateway's
          // usage accounting. The response converter normalizes details at
          // the protocol boundary.
          usage = {
            prompt_tokens: value.input_tokens ?? value.prompt_tokens ?? 0,
            completion_tokens: value.output_tokens ?? value.completion_tokens ?? 0,
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

// ─── Responses request -> Chat Completions ─────────────────────────

export function responsesToChatCompletions(body, options = {}) {
  if (!body || typeof body !== 'object') {
    throw new Error('Responses request body must be an object');
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw new Error('previous_response_id is not supported by the stateless Chat fallback');
  }
  if (body.background) {
    throw new Error('background mode is not supported by the stateless Chat fallback');
  }
  if (body.conversation) {
    throw new Error('conversation state is not supported by the stateless Chat fallback');
  }
  if (Array.isArray(body.context_management) && body.context_management.length > 0) {
    throw new Error('context_management is not supported by the stateless Chat fallback');
  }

  const context = {
    openRouter: !!options.openRouter,
    customTools: new Set(),
  };
  const messages = [];
  const inputTools = Array.isArray(body.tools) ? [...body.tools] : [];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === 'additional_tools' && Array.isArray(item.tools)) {
        inputTools.push(...item.tools);
      }
    }
  }

  if (body.instructions !== undefined && body.instructions !== null) {
    messages.push({ role: 'system', content: instructionsToText(body.instructions) });
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const converted = convertInputItem(item, context);
      if (!converted) continue;
      const values = Array.isArray(converted) ? converted : [converted];
      for (const value of values) appendConvertedMessage(messages, value);
    }
  }

  const result = {
    model: body.model,
    messages,
    stream: !!body.stream,
  };

  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
    result.max_tokens = body.max_output_tokens;
  }
  copyDefined(result, 'temperature', body.temperature);
  copyDefined(result, 'top_p', body.top_p);
  copyDefined(result, 'top_logprobs', body.top_logprobs);
  copyDefined(result, 'store', body.store);
  copyDefined(result, 'safety_identifier', body.safety_identifier);
  if (body.metadata && typeof body.metadata === 'object') result.metadata = { ...body.metadata };
  copyDefined(result, 'parallel_tool_calls', body.parallel_tool_calls);
  copyDefined(result, 'verbosity', body.text?.verbosity);
  copyDefined(result, 'user', body.user);
  copyDefined(result, 'prompt_cache_key', body.prompt_cache_key);
  copyDefined(result, 'prompt_cache_retention', body.prompt_cache_retention);
  if (body.prompt_cache_options && typeof body.prompt_cache_options === 'object') {
    result.prompt_cache_options = { ...body.prompt_cache_options };
  }
  copyDefined(result, 'service_tier', body.service_tier);
  if (body.top_logprobs !== undefined && body.top_logprobs !== null) {
    result.logprobs = true;
  }

  if (body.stream_options && typeof body.stream_options === 'object') {
    // Responses-only options such as reasoning_summary_delivery are not
    // valid Chat Completions fields. Keep the portable streaming controls.
    const streamOptions = {};
    if (body.stream_options.include_usage !== undefined) streamOptions.include_usage = body.stream_options.include_usage;
    if (body.stream_options.include_obfuscation !== undefined) streamOptions.include_obfuscation = body.stream_options.include_obfuscation;
    if (Object.keys(streamOptions).length > 0) result.stream_options = streamOptions;
  }

  const reasoning = mapResponsesReasoning(body.reasoning, context.openRouter);
  if (reasoning) {
    if (reasoning.openRouter) result.reasoning = reasoning.value;
    else Object.assign(result, reasoning.value);
  }

  const responseFormat = mapResponsesText(body.text);
  if (responseFormat) result.response_format = responseFormat;

  const toolResult = mapResponsesToolChoice(body.tool_choice);
  if (toolResult.choice !== undefined) result.tool_choice = toolResult.choice;
  if (toolResult.parallel !== undefined) result.parallel_tool_calls = toolResult.parallel;

  const tools = convertResponsesTools(inputTools, context);
  if (tools.length > 0) result.tools = tools;

  // Do not expose internal conversion metadata to the upstream JSON body.
  Object.defineProperty(result, '__customToolNames', {
    value: [...context.customTools],
    enumerable: false,
  });
  return result;
}

function copyDefined(target, key, value) {
  if (value !== undefined && value !== null) target[key] = value;
}

function instructionsToText(instructions) {
  if (typeof instructions === 'string') return instructions;
  if (Array.isArray(instructions)) {
    return instructions.map((item) => item?.text || contentText(item?.content) || '').filter(Boolean).join('\n');
  }
  return '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.refusal || '';
  }).filter(Boolean).join('');
}

function appendConvertedMessage(messages, value) {
  if (!value) return;
  if (value.__append) {
    delete value.__append;
    messages.push(value);
    return;
  }

  const previous = messages[messages.length - 1];
  if (previous?.role === 'assistant' && value.role === 'assistant') {
    if (value.content !== undefined && value.content !== null && value.content !== '') {
      previous.content = joinMessageContent(previous.content, value.content);
    }
    if (value.tool_calls) {
      previous.tool_calls = [...(previous.tool_calls || []), ...value.tool_calls];
    }
    if (value.reasoning_details) {
      previous.reasoning_details = [
        ...(previous.reasoning_details || []),
        ...value.reasoning_details,
      ];
    }
    if (value.reasoning_content) {
      previous.reasoning_content = `${previous.reasoning_content || ''}${value.reasoning_content}`;
    }
    return;
  }
  messages.push(value);
}

function joinMessageContent(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n${b}`;
  return [...contentArray(a), ...contentArray(b)];
}

function contentArray(content) {
  if (Array.isArray(content)) return content;
  if (content === undefined || content === null || content === '') return [];
  return [{ type: 'text', text: String(content) }];
}

function convertInputItem(item, context) {
  if (typeof item === 'string') return { role: 'user', content: item };
  if (!item || typeof item !== 'object') return null;
  const type = item.type || 'message';

  switch (type) {
    case 'message':
      return convertInputMessage(item, context);
    case 'function_call': {
      const name = item.name;
      if (!name) return null;
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${rid()}`,
          type: 'function',
          function: { name, arguments: item.arguments || '{}' },
        }],
      };
    }
    case 'function_call_output':
      return convertFunctionOutput(item, item.call_id || item.id);
    case 'custom_tool_call': {
      if (!item.name) return null;
      context.customTools.add(item.name);
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${rid()}`,
          type: 'function',
          function: {
            name: item.name,
            // Chat function arguments must be a JSON string.  The wrapper is
            // removed again when the response is converted back to a custom
            // tool call.
            arguments: JSON.stringify({ input: item.input ?? '' }),
          },
        }],
      };
    }
    case 'custom_tool_call_output':
      return convertFunctionOutput(item, item.call_id || item.id);
    case 'reasoning':
      return convertReasoningItem(item, context);
    case 'local_shell_call':
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${rid()}`,
          type: 'function',
          function: { name: 'local_shell', arguments: JSON.stringify(item.action || {}) },
        }],
      };
    case 'shell_call':
    case 'apply_patch_call':
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${rid()}`,
          type: 'function',
          function: {
            name: type === 'apply_patch_call' ? 'apply_patch' : 'shell',
            arguments: JSON.stringify(item.action || item.input || {}),
          },
        }],
      };
    case 'computer_call':
    case 'mcp_call':
    case 'web_search_call':
    case 'file_search_call':
    case 'code_interpreter_call':
    case 'image_generation_call':
      return {
        role: 'assistant',
        content: JSON.stringify(item),
      };
    case 'computer_call_output':
    case 'local_shell_call_output':
    case 'shell_call_output':
    case 'apply_patch_call_output':
    case 'mcp_call_output':
    case 'web_search_call_output':
    case 'file_search_call_output':
    case 'code_interpreter_call_output':
    case 'image_generation_call_output':
      return convertFunctionOutput(item, item.call_id || item.id);
    case 'output_message':
    case 'assistant_message':
      return convertInputMessage({ ...item, role: 'assistant' }, context);
    case 'additional_tools':
      return null; // tools are collected below from the item itself
    case 'item_reference':
    case 'compaction_trigger':
    case 'compaction':
    case 'context_compaction':
    case 'configuration_update':
      throw new Error(`Responses item "${type}" requires a native Responses upstream`);
    default:
      // Do not silently delete a future Responses item.  A visible marker is
      // safer than corrupting a tool-call conversation.
      return { role: 'user', content: `[Responses item ${type}] ${JSON.stringify(item)}` };
  }
}

function convertInputMessage(item, context) {
  if (!item.role) return null;
  const role = item.role === 'developer' ? 'system' : item.role;
  const content = convertMessageContent(item.content, role, context.openRouter);
  if (content === null || content === undefined) return null;
  const message = { role, content };
  if (item.phase) message.phase = item.phase;
  return message;
}

function convertMessageContent(content, role, openRouter) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      parts.push({ type: 'text', text: String(part ?? '') });
      continue;
    }
    switch (part.type) {
      case 'input_text':
      case 'output_text':
      case 'text': {
        const textPart = { type: 'text', text: part.text || '' };
        if (part.prompt_cache_breakpoint) textPart.prompt_cache_breakpoint = part.prompt_cache_breakpoint;
        parts.push(textPart);
        break;
      }
      case 'input_image': {
        if (part.image_url) {
          const image = { type: 'image_url', image_url: { url: part.image_url } };
          if (part.detail && part.detail !== 'original') image.image_url.detail = part.detail;
          if (part.prompt_cache_breakpoint) image.prompt_cache_breakpoint = part.prompt_cache_breakpoint;
          parts.push(image);
        } else if (part.file_id) {
          parts.push({ type: 'text', text: `[image file_id=${part.file_id}]` });
        }
        break;
      }
      case 'input_file': {
        const file = {};
        if (part.file_data !== undefined) file.file_data = part.file_data;
        if (part.file_id !== undefined && part.file_id !== null) file.file_id = part.file_id;
        if (part.file_url !== undefined) file.file_data = part.file_url;
        if (part.filename !== undefined) file.filename = part.filename;
        if (Object.keys(file).length > 0) {
          const filePart = { type: 'file', file };
          if (part.prompt_cache_breakpoint) filePart.prompt_cache_breakpoint = part.prompt_cache_breakpoint;
          parts.push(filePart);
        }
        break;
      }
      case 'input_audio': {
        const audio = part.input_audio || part;
        if (audio.data) {
          parts.push({
            type: 'input_audio',
            input_audio: { data: audio.data, format: audio.format || 'wav' },
          });
        } else if (audio.audio_url) {
          const match = /^data:audio\/([^;]+);base64,(.+)$/i.exec(audio.audio_url);
          const format = match?.[1]?.toLowerCase() === 'mpeg' ? 'mp3' : match?.[1]?.toLowerCase();
          if (match && (format === 'wav' || format === 'mp3')) {
            parts.push({
              type: 'input_audio',
              input_audio: { data: match[2], format },
            });
          } else {
            parts.push({ type: 'text', text: `[audio ${audio.audio_url}]` });
          }
        }
        break;
      }
      case 'refusal':
        parts.push({ type: 'text', text: part.refusal || '' });
        break;
      default:
        parts.push({ type: 'text', text: JSON.stringify(part) });
    }
  }

  if (role === 'assistant') {
    return parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
  }
  if (parts.length > 0 && parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('\n');
  }
  return parts;
}

function convertFunctionOutput(item, callId) {
  if (!callId) return null;
  const output = item.output ?? item.result ?? item.action ?? '';
  if (typeof output === 'string') {
    return { role: 'tool', tool_call_id: callId, content: output };
  }
  if (Array.isArray(output)) {
    const textParts = [];
    const followupParts = [];
    for (const part of output) {
      if (typeof part === 'string') {
        textParts.push(part);
      } else if (part?.type === 'input_text' || part?.type === 'output_text') {
        textParts.push(part.text || '');
      } else if (part?.type === 'input_image') {
        if (part.image_url) {
          followupParts.push({ type: 'image_url', image_url: { url: part.image_url } });
        } else if (part.file_id) {
          textParts.push(`[image file_id=${part.file_id}]`);
        }
      } else if (part?.type === 'input_file') {
        if (part.file_data || part.file_id || part.file_url) {
          followupParts.push({
            type: 'file',
            file: {
              ...(part.file_data !== undefined ? { file_data: part.file_data } : {}),
              ...(part.file_id ? { file_id: part.file_id } : {}),
              ...(part.file_url ? { file_data: part.file_url } : {}),
              ...(part.filename ? { filename: part.filename } : {}),
            },
          });
        } else {
          textParts.push('[file result]');
        }
      } else {
        textParts.push(JSON.stringify(part));
      }
    }
    const messages = [{ role: 'tool', tool_call_id: callId, content: textParts.join('\n') }];
    if (followupParts.length > 0) messages.push({ role: 'user', content: followupParts });
    return messages;
  }
  return { role: 'tool', tool_call_id: callId, content: JSON.stringify(output) };
}

function convertReasoningItem(item, context) {
  const details = [];
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const content = Array.isArray(item.content) ? item.content : [];
  for (const part of summary) {
    if (part?.text) details.push({ type: 'reasoning.summary', summary: part.text });
  }
  for (const part of content) {
    if (part?.text) details.push({ type: 'reasoning.text', text: part.text, signature: null });
  }
  if (item.encrypted_content) {
    details.push({ type: 'reasoning.encrypted', data: item.encrypted_content });
  }
  const message = { role: 'assistant', content: null };
  if (context.openRouter && details.length > 0) {
    message.reasoning_details = details;
  } else {
    const text = [...summary, ...content].map((part) => part?.text || '').join('\n');
    if (text) message.reasoning_content = text;
    else if (item.encrypted_content) message.reasoning_content = '[encrypted reasoning]';
    else return null;
  }
  return message;
}

function mapResponsesReasoning(reasoning, openRouter) {
  if (!reasoning || typeof reasoning !== 'object') return null;
  if (openRouter) {
    const value = {};
    if (reasoning.effort !== undefined && reasoning.effort !== null) value.effort = reasoning.effort;
    if (reasoning.context !== undefined && reasoning.context !== null) value.context = reasoning.context;
    if (reasoning.mode !== undefined && reasoning.mode !== null) value.mode = reasoning.mode;
    if (Object.keys(value).length > 0) return { openRouter: true, value };
  }
  if (reasoning.effort !== undefined && reasoning.effort !== null) {
    return { value: { reasoning_effort: reasoning.effort } };
  }
  return null;
}

function mapResponsesText(text) {
  const format = text?.format;
  if (!format) return null;
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name || 'response',
        description: format.description,
        schema: format.schema || format.json_schema?.schema || {},
        strict: format.strict === true,
      },
    };
  }
  if (format.type === 'json_object') return { type: 'json_object' };
  return null;
}

function mapResponsesToolChoice(choice) {
  if (choice === undefined || choice === null) return {};
  if (typeof choice === 'string') return { choice };
  if (!choice || typeof choice !== 'object') return {};

  const parallel = choice.disable_parallel_tool_use === true
    ? false
    : choice.disable_parallel_tool_use === false
      ? true
      : undefined;
  if (choice.type === 'function' || choice.type === 'custom') {
    return choice.name
      ? { choice: { type: 'function', function: { name: choice.name } }, parallel }
      : { parallel };
  }
  if (choice.type === 'allowed_tools') {
    const allowed = choice.allowed_tools || {};
    if (allowed.mode && Array.isArray(allowed.tools)) {
      return {
        choice: {
          type: 'allowed_tools',
          allowed_tools: { mode: allowed.mode, tools: allowed.tools },
        },
        parallel,
      };
    }
  }
  if (choice.type === 'auto' || choice.type === 'none' || choice.type === 'required') {
    return { choice: choice.type, parallel };
  }
  return { parallel };
}

function convertResponsesTools(tools, context) {
  if (!Array.isArray(tools)) return [];
  const result = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function') {
      result.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: sanitizeSchema(tool.parameters || { type: 'object' }),
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      });
    } else if (tool.type === 'custom') {
      if (!tool.name) continue;
      context.customTools.add(tool.name);
      result.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false,
          },
          strict: false,
        },
      });
    } else if (tool.type === 'namespace') {
      result.push(...convertResponsesTools(tool.tools, context));
    } else if (tool.type === 'local_shell' || tool.type === 'function_shell' || tool.type === 'apply_patch') {
      const name = tool.type === 'apply_patch' ? 'apply_patch' : tool.type === 'local_shell' ? 'local_shell' : 'shell';
      if (tool.type === 'apply_patch') context.customTools.add(name);
      result.push({
        type: 'function',
        function: {
          name,
          description: tool.description || `Responses ${tool.type} tool`,
          parameters: tool.type === 'apply_patch'
            ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
            : { type: 'object', additionalProperties: true },
        },
      });
    } else if (tool.type === 'web_search' || tool.type === 'file_search' || tool.type === 'computer' || tool.type === 'code_interpreter') {
      // These are server-side Responses tools.  They cannot be emulated by a
      // normal Chat Completions request without changing their semantics.
      throw new Error(`Responses server tool "${tool.type}" is not supported by the Chat fallback`);
    }
  }
  return result;
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
}

export function getCustomToolNames(chatBody) {
  return Array.isArray(chatBody?.__customToolNames) ? chatBody.__customToolNames : [];
}

// ─── Chat response -> Responses response ────────────────────────────

export function chatCompletionsToResponses(openaiData, model, options = {}) {
  const customTools = new Set(options.customToolNames || []);
  const response = baseResponse(openaiData, model);
  const choice = openaiData?.choices?.[0];
  const message = choice?.message || {};

  appendReasoningOutput(response, message, customTools);

  if (message.content !== undefined && message.content !== null) {
    if (typeof message.content === 'string') {
      if (message.content) appendTextOutput(response, message.content);
    } else if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part?.type === 'text' || part?.type === 'output_text')
        .map((part) => part.text || '')
        .join('');
      if (text) appendTextOutput(response, text);
      const refusal = message.content
        .filter((part) => part?.type === 'refusal')
        .map((part) => part.refusal || '')
        .join('');
      if (refusal) appendRefusalOutput(response, refusal);
    }
  }
  if (message.refusal) appendRefusalOutput(response, message.refusal);

  for (const call of message.tool_calls || []) {
    const fn = call.function || call;
    if (!fn?.name) continue;
    const isCustom = customTools.has(fn.name);
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    if (isCustom) {
      let input = args;
      try {
        const parsed = JSON.parse(args);
        input = typeof parsed?.input === 'string' ? parsed.input : args;
      } catch {}
      response.output.push({
        id: `ctc_${rid()}`,
        type: 'custom_tool_call',
        call_id: call.id || `call_${rid()}`,
        name: fn.name,
        input,
        status: 'completed',
      });
    } else {
      response.output.push({
        id: `fc_${rid()}`,
        type: 'function_call',
        call_id: call.id || `call_${rid()}`,
        name: fn.name,
        arguments: args,
        status: 'completed',
      });
    }
  }

  if (choice?.finish_reason === 'length') {
    response.status = 'incomplete';
    response.incomplete_details = { reason: 'max_output_tokens' };
  }
  if (choice?.finish_reason === 'content_filter') {
    response.status = 'incomplete';
    response.incomplete_details = { reason: 'content_filter' };
  }
  if (openaiData?.error) {
    response.status = 'failed';
    response.error = normalizeError(openaiData.error);
  }
  return response;
}

function appendTextOutput(response, text) {
  response.output.push({
    id: `msg_${rid()}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
  response.output_text += text;
}

function appendRefusalOutput(response, refusal) {
  response.output.push({
    id: `msg_${rid()}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'refusal', refusal }],
  });
}

function baseResponse(openaiData, model) {
  const usage = normalizeUsage(openaiData?.usage);
  return {
    id: openaiData?.id ? `resp_${String(openaiData.id).replace(/^resp_/, '')}` : `resp_${rid()}`,
    object: 'response',
    created_at: openaiData?.created || Math.floor(Date.now() / 1000),
    completed_at: openaiData?.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model || openaiData?.model || 'unknown',
    output: [],
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    usage,
  };
}

function appendReasoningOutput(response, message, customTools) {
  const details = Array.isArray(message.reasoning_details) ? message.reasoning_details : [];
  const summaries = [];
  const content = [];
  let encrypted = null;
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    if (detail.type === 'reasoning.encrypted' || detail.type === 'reasoning_encrypted') {
      encrypted = detail.data || detail.encrypted_content || encrypted;
    } else if (detail.summary || detail.type === 'reasoning.summary') {
      summaries.push({ type: 'summary_text', text: detail.summary || detail.text || '' });
    } else if (detail.text || detail.type === 'reasoning.text') {
      content.push({ type: 'reasoning_text', text: detail.text || '' });
    }
  }
  const plain = message.reasoning_content || message.reasoning;
  const plainText = typeof plain === 'string' ? plain : plain?.text || plain?.content || '';
  if ((!details.length || (!summaries.length && !content.length && !encrypted)) && plainText) {
    content.push({ type: 'reasoning_text', text: String(plainText) });
  }
  if (summaries.length || content.length || encrypted) {
    const item = {
      id: `rs_${rid()}`,
      type: 'reasoning',
      summary: summaries,
      content,
      status: 'completed',
    };
    if (encrypted) item.encrypted_content = encrypted;
    response.output.unshift(item);
  }
}

function normalizeError(error) {
  if (typeof error === 'string') return { code: 'server_error', message: error };
  return {
    code: error?.code || 'server_error',
    message: error?.message || String(error),
  };
}

function normalizeUsage(usage) {
  const source = usage || {};
  const inputDetails = source.input_tokens_details || source.prompt_tokens_details || {};
  const outputDetails = source.output_tokens_details || source.completion_tokens_details || {};
  const input = source.input_tokens ?? source.prompt_tokens ?? 0;
  const output = source.output_tokens ?? source.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: inputDetails.cached_tokens ?? 0,
      cache_write_tokens: inputDetails.cache_write_tokens ?? inputDetails.cache_creation_tokens ?? 0,
    },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: outputDetails.reasoning_tokens ?? source.reasoning_tokens ?? 0,
    },
    total_tokens: source.total_tokens ?? input + output,
  };
}

// ─── Chat SSE -> Responses SSE ──────────────────────────────────────

export function chatCompletionsStreamToResponsesStream(upstreamBody, model, options = {}) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const customTools = new Set(options.customToolNames || []);
  const responseId = `resp_${rid()}`;
  const responseObject = baseResponse(null, model);
  responseObject.status = 'in_progress';
  responseObject.output = [];
  responseObject.output_text = '';
  responseObject.usage = normalizeUsage(null);

  let buffer = '';
  let sequenceNumber = 0;
  let outputIndex = 0;
  let usage = null;
  let messageItem = null;
  let messageTextOpen = false;
  let reasoningItem = null;
  let reasoningContentIndex = 0;
  const toolCalls = new Map();
  let terminalSent = false;
  let pendingFinishReason = null;

  function seq() { return sequenceNumber++; }
  function send(ctrl, type, fields) {
    ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type, sequence_number: seq(), ...fields })}\n\n`));
  }
  function ensureMessage(ctrl) {
    if (messageItem) return messageItem;
    messageItem = {
      id: `msg_${rid()}`,
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    };
    const index = outputIndex++;
    responseObject.output.push(messageItem);
    send(ctrl, 'response.output_item.added', { output_index: index, item: messageItem });
    return messageItem;
  }
  function ensureTextPart(ctrl) {
    const item = ensureMessage(ctrl);
    if (messageTextOpen) return item;
    const part = { type: 'output_text', text: '', annotations: [] };
    item.content.push(part);
    messageTextOpen = true;
    send(ctrl, 'response.content_part.added', {
      item_id: item.id,
      output_index: responseObject.output.indexOf(item),
      content_index: item.content.length - 1,
      part,
    });
    return item;
  }
  function closeTextPart(ctrl) {
    if (!messageItem || !messageTextOpen) return;
    const item = ensureMessage(ctrl);
    const contentIndex = item.content.length - 1;
    const part = item.content[contentIndex];
    responseObject.output_text += part.text;
    send(ctrl, 'response.output_text.done', {
      item_id: item.id,
      output_index: responseObject.output.indexOf(item),
      content_index: contentIndex,
      text: part.text,
      logprobs: [],
    });
    send(ctrl, 'response.content_part.done', {
      item_id: item.id,
      output_index: responseObject.output.indexOf(item),
      content_index: contentIndex,
      part,
    });
    messageTextOpen = false;
  }
  function closeMessage(ctrl) {
    closeTextPart(ctrl);
    if (!messageItem) return;
    messageItem.status = 'completed';
    const index = responseObject.output.indexOf(messageItem);
    send(ctrl, 'response.output_item.done', { output_index: index, item: messageItem });
    messageItem = null;
  }
  function ensureReasoning(ctrl) {
    if (reasoningItem) return reasoningItem;
    reasoningItem = {
      id: `rs_${rid()}`,
      type: 'reasoning',
      summary: [],
      content: [],
      status: 'in_progress',
    };
    const index = outputIndex++;
    responseObject.output.push(reasoningItem);
    send(ctrl, 'response.output_item.added', { output_index: index, item: reasoningItem });
    return reasoningItem;
  }
  function closeReasoning(ctrl) {
    if (!reasoningItem) return;
    reasoningItem.status = 'completed';
    const index = responseObject.output.indexOf(reasoningItem);
    for (let i = 0; i < reasoningItem.content.length; i++) {
      const part = reasoningItem.content[i];
      send(ctrl, 'response.reasoning_text.done', {
        item_id: reasoningItem.id,
        output_index: index,
        content_index: i,
        text: part.text,
      });
    }
    send(ctrl, 'response.output_item.done', { output_index: index, item: reasoningItem });
    reasoningItem = null;
  }
  function addReasoning(ctrl, text, detail) {
    if (!text) return;
    const item = ensureReasoning(ctrl);
    const index = responseObject.output.indexOf(item);
    if (detail?.type === 'reasoning.summary' || detail?.summary) {
      const part = { type: 'summary_text', text: String(detail.summary || text) };
      const summaryIndex = item.summary.length;
      item.summary.push(part);
      send(ctrl, 'response.reasoning_summary_part.added', {
        item_id: item.id, output_index: index, summary_index: summaryIndex, part,
      });
      send(ctrl, 'response.reasoning_summary_text.delta', {
        item_id: item.id, output_index: index, summary_index: summaryIndex, delta: part.text,
      });
      send(ctrl, 'response.reasoning_summary_text.done', {
        item_id: item.id, output_index: index, summary_index: summaryIndex, text: part.text,
      });
      send(ctrl, 'response.reasoning_summary_part.done', {
        item_id: item.id, output_index: index, summary_index: summaryIndex, part,
      });
      return;
    }

    const part = { type: 'reasoning_text', text: String(text) };
    const contentIndex = item.content.length;
    item.content.push(part);
    send(ctrl, 'response.reasoning_text.delta', {
      item_id: item.id,
      output_index: index,
      content_index: contentIndex,
      delta: part.text,
    });
  }

  function addEncryptedReasoning(ctrl, data) {
    if (!data) return;
    const item = ensureReasoning(ctrl);
    item.encrypted_content = data;
  }

  function ensureRefusal(ctrl) {
    if (refusalItem) return refusalItem;
    refusalItem = {
      id: `msg_${rid()}`,
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [{ type: 'refusal', refusal: '' }],
    };
    const index = outputIndex++;
    responseObject.output.push(refusalItem);
    send(ctrl, 'response.output_item.added', { output_index: index, item: refusalItem });
    return refusalItem;
  }

  function addRefusal(ctrl, text) {
    if (!text) return;
    const item = ensureRefusal(ctrl);
    const part = item.content[0];
    const index = responseObject.output.indexOf(item);
    part.refusal += text;
    send(ctrl, 'response.refusal.delta', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      delta: text,
    });
  }

  function closeRefusal(ctrl) {
    if (!refusalItem) return;
    const item = refusalItem;
    const index = responseObject.output.indexOf(item);
    item.status = 'completed';
    send(ctrl, 'response.refusal.done', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      refusal: item.content[0].refusal,
    });
    send(ctrl, 'response.output_item.done', { output_index: index, item });
    refusalItem = null;
  }

  function addToolCall(ctrl, toolCall) {
    if (!toolCall || typeof toolCall !== 'object') return;
    const chatIndex = toolCall.index ?? 0;
    let state = toolCalls.get(chatIndex);
    const fn = toolCall.function || toolCall;
    const name = fn.name;
    if (!name) return;
    const isCustom = customTools.has(name);
    const callId = toolCall.id || fn.id || `call_${rid()}`;

    if (!state) {
      const item = isCustom
        ? {
            id: `ctc_${rid()}`,
            type: 'custom_tool_call',
            call_id: callId,
            name,
            input: '',
            status: 'in_progress',
          }
        : {
            id: `fc_${rid()}`,
            type: 'function_call',
            call_id: callId,
            name,
            arguments: '',
            status: 'in_progress',
          };
      state = { item, outputIndex: outputIndex++, arguments: '', closed: false };
      toolCalls.set(chatIndex, state);
      responseObject.output.push(state.item);
      send(ctrl, 'response.output_item.added', {
        output_index: state.outputIndex,
        item: state.item,
      });
    }

    const args = fn.arguments || '';
    state.arguments += args;
    if (isCustom) {
      let inputDelta = args;
      try {
        const parsed = JSON.parse(args);
        if (typeof parsed?.input === 'string') inputDelta = parsed.input;
      } catch {}
      state.item.input += inputDelta;
      send(ctrl, 'response.custom_tool_call_input.delta', {
        item_id: state.item.id,
        output_index: state.outputIndex,
        delta: inputDelta,
      });
    } else {
      state.item.arguments = state.arguments;
      send(ctrl, 'response.function_call_arguments.delta', {
        item_id: state.item.id,
        output_index: state.outputIndex,
        delta: args,
      });
    }
  }

  function closeToolCall(ctrl, state) {
    if (!state || state.closed) return;
    state.closed = true;
    state.item.status = 'completed';
    if (state.item.type === 'custom_tool_call') {
      send(ctrl, 'response.custom_tool_call_input.done', {
        item_id: state.item.id,
        output_index: state.outputIndex,
        input: state.item.input,
      });
    } else {
      send(ctrl, 'response.function_call_arguments.done', {
        item_id: state.item.id,
        output_index: state.outputIndex,
        arguments: state.item.arguments,
      });
    }
    send(ctrl, 'response.output_item.done', {
      output_index: state.outputIndex,
      item: state.item,
    });
  }

  function closeAll(ctrl) {
    closeMessage(ctrl);
    closeRefusal(ctrl);
    closeReasoning(ctrl);
    for (const state of toolCalls.values()) closeToolCall(ctrl, state);
  }

  function finish(ctrl, finishReason) {
    if (terminalSent || pendingFinishReason !== null) return;
    // OpenAI-compatible providers commonly send the finish chunk before the
    // usage-only chunk. Keep the terminal Responses event until EOF so the
    // completed response contains the final usage numbers.
    pendingFinishReason = finishReason || 'stop';
    closeAll(ctrl);
  }

  function finalize(ctrl) {
    if (terminalSent) return;
    const finishReason = pendingFinishReason || 'stop';
    responseObject.usage = normalizeUsage(usage);
    if (finishReason === 'length' || finishReason === 'content_filter') {
      responseObject.status = 'incomplete';
      responseObject.incomplete_details = {
        reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter',
      };
      send(ctrl, 'response.incomplete', { response: responseObject });
    } else {
      responseObject.status = 'completed';
      send(ctrl, 'response.completed', { response: responseObject });
    }
    terminalSent = true;
  }

  let refusalItem = null;
  let resolveUsage;
  const usagePromise = new Promise((resolve) => { resolveUsage = resolve; });

  return { stream: new ReadableStream({
    async start(ctrl) {
      const reader = upstreamBody.getReader();
      send(ctrl, 'response.created', { response: { ...responseObject } });
      send(ctrl, 'response.in_progress', { response: { ...responseObject } });

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
                responseObject.status = 'failed';
                responseObject.error = normalizeError(data.error);
                send(ctrl, 'response.failed', { response: responseObject });
                terminalSent = true;
                pendingFinishReason = null;
                continue;
              }
              if (data.usage) usage = data.usage;
              if (!Array.isArray(data.choices) || data.choices.length === 0) continue;
              const choice = data.choices[0];
              const delta = choice.delta || {};

              let handledReasoning = false;
              if (Array.isArray(delta.reasoning_details)) {
                for (const detail of delta.reasoning_details) {
                  if (!detail || typeof detail !== 'object') continue;
                  handledReasoning = true;
                  if (detail.type === 'reasoning.encrypted' || detail.type === 'reasoning_encrypted') {
                    addEncryptedReasoning(ctrl, detail.data || detail.encrypted_content);
                  } else {
                    addReasoning(ctrl, detail.text || detail.summary || detail.content, detail);
                  }
                }
              }
              if (!handledReasoning) {
                const reasoning = delta.reasoning_content ?? delta.reasoning_text ?? delta.reasoning;
                const reasoningText = typeof reasoning === 'string'
                  ? reasoning
                  : reasoning?.text || reasoning?.content || '';
                if (reasoningText) addReasoning(ctrl, reasoningText, null);
              }

              const text = extractText(delta.content);
              const refusalText = extractRefusal(delta.content);
              if (text) {
                ensureTextPart(ctrl);
                const item = messageItem;
                const part = item.content[item.content.length - 1];
                const index = responseObject.output.indexOf(item);
                part.text += text;
                send(ctrl, 'response.output_text.delta', {
                  item_id: item.id,
                  output_index: index,
                  content_index: item.content.length - 1,
                  delta: text,
                  logprobs: [],
                });
              }
              if (refusalText) addRefusal(ctrl, refusalText);
              if (delta.refusal) addRefusal(ctrl, String(delta.refusal));

              if (Array.isArray(delta.tool_calls)) {
                for (const call of delta.tool_calls) addToolCall(ctrl, call);
              }
              if (choice.finish_reason) finish(ctrl, choice.finish_reason);
            }
          }
        }
        if (!terminalSent) finalize(ctrl);
      } catch (error) {
        if (!terminalSent) {
          responseObject.status = 'failed';
          responseObject.error = { code: 'server_error', message: error instanceof Error ? error.message : String(error) };
          send(ctrl, 'response.failed', { response: responseObject });
          terminalSent = true;
        }
      } finally {
        try { reader.releaseLock(); } catch {}
        if (!terminalSent) finalize(ctrl);
        resolveUsage(usage);
        ctrl.close();
      }
    },
  }), usagePromise };
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => typeof part === 'string' || part?.type === 'text' || part?.type === 'output_text')
    .map((part) => typeof part === 'string' ? part : part.text || '')
    .join('');
}

function extractRefusal(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'refusal')
    .map((part) => part.refusal || '')
    .join('');
}

function rid() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
