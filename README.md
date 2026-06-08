# Anthropic Codex Proxy

Local Node.js proxy that exposes a small Anthropic Messages-compatible API and forwards requests to an OpenAI Responses-compatible upstream.

Detailed setup, Claude Desktop configuration, plugin usage, model routing, token-window behavior, and troubleshooting are documented in [docs/PROXY.md](docs/PROXY.md).

Supported upstreams:

- `UPSTREAM=codex`: ChatGPT/Codex OAuth backend used by Codex-style clients. Intended only for personal local development with your own account.
- `UPSTREAM=openai`: official OpenAI Platform `/v1/responses` endpoint with `OPENAI_API_KEY`.

The Codex OAuth flow mirrors the public behavior documented by `opencode-openai-codex-auth`: PKCE OAuth with client id `app_EMoamEEZ73f0CkXaXp7hrann`, callback on `http://localhost:1455/auth/callback`, and requests to `https://chatgpt.com/backend-api/codex/responses` with `store:false`.

## Setup

```bash
cp .env.example .env
npm run auth
npm start
```

The auth command stores local OAuth tokens in `.auth/codex.json` with file mode `0600`. The file is ignored by git.

The server loads `.env` automatically when present. Existing environment variables take priority over `.env` values.

For official OpenAI Platform mode:

```bash
UPSTREAM=openai OPENAI_API_KEY=sk-... npm start
```

## Client Configuration

Point Anthropic-compatible clients at:

```text
http://127.0.0.1:8787
```

Use any Anthropic API key value unless you set `PROXY_API_KEY`. If `PROXY_API_KEY` is set, clients must send the same value as `x-api-key` or `Authorization: Bearer`.

For Claude Desktop, enable Developer Mode and configure third-party inference:

```text
Help -> Troubleshooting -> Enable Developer Mode
Developer -> Configure third-party inference
Connection: Gateway (Anthropic-compatible)
```

| Field | Value |
| --- | --- |
| Base URL / Endpoint | `http://127.0.0.1:8787` |
| API key | `local` unless `PROXY_API_KEY` is set |
| Models | `opus`, `sonnet`, `haiku` |

Use the root base URL without `/v1`; Claude Desktop appends Anthropic API paths itself.

See [docs/PROXY.md](docs/PROXY.md) for detailed Claude Desktop notes.

Example curl:

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: local' \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

Streaming is supported through Anthropic-style SSE events:

```json
{"stream": true}
```

## Claude Plugin

This repository also includes a local Claude plugin package at:

```text
claude-plugin/anthropic-proxy
```

It exposes namespaced helper skills:

- `/anthropic-proxy:plugin`
- `/anthropic-proxy:status`
- `/anthropic-proxy:models`
- `/anthropic-proxy:debug`

The plugin includes a stdio MCP server that checks the local proxy at `http://127.0.0.1:8787`.

For Claude Code development:

```bash
claude --plugin-dir ./claude-plugin/anthropic-proxy
```

For Claude Desktop, zip the plugin directory and upload it as a custom plugin:

```bash
cd claude-plugin
zip -r anthropic-proxy-plugin.zip anthropic-proxy
```

## Configuration

- `HOST`, `PORT`: bind address. Default is `127.0.0.1:8787`.
- `PROXY_API_KEY`: optional incoming auth gate.
- `UPSTREAM`: `codex` or `openai`.
- `DEFAULT_MODEL`: fallback upstream model used when no Claude family profile matches.
- `ANTHROPIC_DISCOVERY_MODELS`: comma-separated model ids returned from `/v1/models`. Default: `opus,sonnet,haiku`.
- `ANTHROPIC_MODELS`: extra model ids accepted by the proxy even when they are not advertised.
- `CLAUDE_OPUS_MODEL`, `CLAUDE_SONNET_MODEL`, `CLAUDE_HAIKU_MODEL`: upstream GPT/Codex target models for Claude family aliases.
- `CLAUDE_OPUS_REASONING_EFFORT`, `CLAUDE_SONNET_REASONING_EFFORT`, `CLAUDE_HAIKU_REASONING_EFFORT`: per-family reasoning profile for Codex mode.
- `CLAUDE_OPUS_TEXT_VERBOSITY`, `CLAUDE_SONNET_TEXT_VERBOSITY`, `CLAUDE_HAIKU_TEXT_VERBOSITY`: per-family output verbosity profile for Codex mode.
- `CODEX_CONTEXT_WINDOW_TOKENS`: raw upstream context window. Default: `400000`.
- `CODEX_CONTEXT_RESERVE_TOKENS`: hard reserve kept for output, instructions, and token-estimation drift. Default: `8192`.
- `CODEX_MAX_INPUT_TOKENS`: soft input context budget advertised in `/v1/models` so clients compact early. Default: `367232`.
- `CODEX_HARD_INPUT_TOKENS`: hard input budget before proxy-side trimming or error. Default: `391808`.
- `CLAUDE_OPUS_MAX_OUTPUT_TOKENS`, `CLAUDE_SONNET_MAX_OUTPUT_TOKENS`, `CLAUDE_HAIKU_MAX_OUTPUT_TOKENS`: advertised max output tokens per family. In `UPSTREAM=openai` mode the proxy sends a hard Responses API limit; in `UPSTREAM=codex` mode the ChatGPT-backed Codex endpoint rejects that parameter, so the proxy applies it as an instruction-level output budget. Defaults: `8192`, `8192`, `4096`.
- `TOKEN_ESTIMATE_MULTIPLIER`: safety multiplier for local `/count_tokens` estimates. Default: `1.15`.
- `IMAGE_TOKEN_ESTIMATE`: local token estimate for image blocks when dimensions are unknown. Default: `1024`.
- `CONTEXT_OVERFLOW_STRATEGY`: `trim` removes oldest messages before hard overflow; `error` returns a 400. Default: `trim`.
- `CONTEXT_TRIM_NOTICE`: whether to add an instruction note when old messages were trimmed. Default: `true`.
- `MODEL_MAP`: comma-separated exact override map, for example `claude-sonnet-4-6=gpt-5.4,claude-opus-4-8=gpt-5.5`.
- `CODEX_AUTH_FILE`: path for OAuth token storage.
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`: official OpenAI Platform mode.
- `CODEX_INSTRUCTIONS`: fallback instructions sent to Codex when the Anthropic request has no `system` field. Supports `{{current_date}}`, `{{requested_model}}`, `{{upstream_model}}`, and `{{model_family}}`.
- `REASONING_EFFORT`, `REASONING_SUMMARY`, `TEXT_VERBOSITY`: request defaults for Codex mode.

## API Coverage

Implemented:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens` with a local approximate token estimate
- `GET /v1/models`
- `GET /v1/models/:model_id`
- `GET /health`
- Text messages
- Basic image input blocks with base64 data URLs
- Tools: Anthropic `tool_use` and `tool_result` mapped to OpenAI Responses function calls
- Claude family aliases: `opus`, `sonnet`, `haiku`, and model ids containing those family names
- Non-streaming JSON responses
- Streaming Anthropic SSE responses

Not implemented:

- Anthropic-specific extended thinking fields
- Prompt caching headers
- Full parity with every Anthropic beta feature

## Notes

This project does not log OAuth access or refresh tokens. Keep `.auth/codex.json` private. Do not expose this server on a public interface without `PROXY_API_KEY`.
