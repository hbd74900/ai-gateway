# Protocol compatibility

This gateway has three client-facing protocol paths:

| Client path | OpenAI-compatible target | Native target |
|---|---|---|
| OpenAI Chat Completions | JSON passthrough | same |
| OpenAI Responses (Codex) | Responses → Chat conversion | Responses passthrough |
| Claude Messages | Messages → Chat conversion | Messages passthrough |

The native paths are selected automatically for the official OpenAI,
OpenRouter, and Anthropic endpoint shapes. A private proxy can override this
with `responses_mode` and `messages_mode` (`auto`, `native`, or `chat`) in the
channel editor/API.

A client-side error such as `Unknown thinking level "max". Available levels:
off` is produced before any HTTP request (for example, by pi when a custom
`models.json` entry omits `reasoning: true`); it is not an upstream gateway
error. The gateway/model metadata controls what is forwarded after the client
has selected a level. For a model that requires reasoning, the corresponding
client entry should declare `reasoning: true` and map the supported levels;
for OpenRouter's Space Bunny Alpha, `low/medium/high/xhigh/max` are the relevant
levels and `off` is not. OpenRouter documents that `max` may reserve roughly
95% of the output budget for reasoning, so a very small `maxTokens` can leave
too little room for the final answer.

## Claude Messages

For OpenRouter and Anthropic-compatible upstreams, `/v1/messages` is sent to
`/messages` without conversion. This preserves features that cannot be
represented by Chat Completions:

- `thinking.type=adaptive|enabled|disabled`
- `output_config.effort` and structured output schemas
- thinking/redacted-thinking signatures and replay
- `cache_control` breakpoints
- citations, documents, images, and server-side tool blocks
- Claude SSE event ordering and usage fields

For Chat-only upstreams, the adapter maps the portable subset to Chat:

- system/messages, text, images, documents, client tools and tool results
- `max_tokens`, sampling fields, `stop_sequences`, `tool_choice`
- `output_config.effort` and portable `thinking` controls
- JSON structured output
- OpenRouter `reasoning_details` and `cache_control` when the target is
  OpenRouter

Features that are server-side Anthropic features (`context_management.edits`,
MCP servers, compaction, containers, and hosted tools), plus adaptive or
budget-based thinking without an OpenRouter reasoning mapping, are rejected for
a Chat fallback instead of being silently guessed. Route those requests to a
native Messages target.

Key Chat-fallback mappings:

| Claude field | Chat/OpenRouter field |
|---|---|
| `max_tokens` | `max_tokens` |
| `stop_sequences` | `stop` |
| `tool_choice.type=any` | `tool_choice=required` |
| `disable_parallel_tool_use` | `parallel_tool_calls=false` |
| `output_config.effort` | `reasoning.effort` (OpenRouter) or `reasoning_effort` |
| `thinking.enabled.budget_tokens` | `reasoning.max_tokens` (OpenRouter) |
| `output_config.format` | `response_format.json_schema` |
| assistant `thinking` / `redacted_thinking` | `reasoning_details` (OpenRouter) |
| tool result text/image/document | tool message plus user multimodal parts |

## OpenAI Responses / Codex

Native Responses targets receive the original request and SSE stream. This is
important for Codex features such as:

- `reasoning.effort`, summaries, and encrypted reasoning items
- `include: ["reasoning.encrypted_content"]`
- `store:false`, prompt-cache keys/options, service tier, and text controls
- function, custom/freeform, local-shell, and image/file input items
- stateful/background fields when the upstream supports them

The Chat fallback covers the common stateless subset and translates function
and custom tool calls back to Responses events/items. It deliberately rejects
stateful conversation IDs, background mode, and hosted server tools that a
Chat endpoint cannot implement.

Key Chat-fallback mappings:

| Responses field/item | Chat field/message |
|---|---|
| `reasoning.effort` | `reasoning.effort` (OpenRouter) or `reasoning_effort` |
| `text.verbosity` | `verbosity` |
| `text.format` | `response_format` |
| `function_call` | assistant `tool_calls` |
| `function_call_output` | `role=tool` |
| `custom_tool_call` | function fallback, converted back to `custom_tool_call` |
| `local_shell_call` | assistant function fallback |
| `input_text` / `input_image` / `input_file` / `input_audio` | Chat content parts |
| Responses reasoning item | assistant `reasoning_details` / `reasoning_content` |

A non-streaming native Responses response is returned from the upstream
response body. It is never replaced with the request body.

## Evidence used

- Anthropic official SDK, Messages types and stream events:
  <https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts>
- Anthropic Messages API:
  <https://platform.claude.com/docs/en/api/messages>
- Anthropic extended thinking:
  <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>
- OpenAI official Node SDK, Responses types/events:
  <https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts>
- OpenAI official Node SDK, Chat Completions types:
  <https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts>
- Codex `ResponsesApiRequest` and SSE parser:
  <https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs>
  and
  <https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs>
- OpenRouter reasoning details and native Anthropic Messages support:
  <https://openrouter.ai/docs/use-cases/reasoning-tokens>
  and
  <https://openrouter.ai/docs/api-reference/overview>

The audit was performed against these upstream revisions (the links above are
kept on the default branch for readability):

- `anthropic/anthropic-sdk-typescript` `1926adb4d292090975e6b5d19ebafe2274d2469e`
- `openai/openai-node` `5d258e4e82d7655fa82a4688fc04c53359417d27`
- `openai/codex` `f6fd7f17ed2ef4bf28e5b320789d764350ce4529`

Run the protocol regression suite with:

```bash
npm test
```
