# Anthropic Codex Proxy: руководство

Локальный proxy поднимает Anthropic Messages-compatible HTTP API и перенаправляет запросы в OpenAI-compatible upstream.

Основной режим этого проекта - `UPSTREAM=codex`: запросы уходят в ChatGPT-backed Codex endpoint с OAuth авторизацией через вашу подписку ChatGPT. Есть также режим `UPSTREAM=openai` для официального OpenAI Platform API key.

## Что умеет proxy

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /v1/models/:model_id`
- `GET /health`
- Anthropic-style streaming через SSE
- text messages
- base64 image blocks
- Anthropic `tool_use` / `tool_result` -> OpenAI Responses function calls
- Claude-like aliases: `opus`, `sonnet`, `haiku`

Не реализовано полностью:

- Anthropic extended thinking fields
- prompt caching headers
- полная совместимость со всеми Anthropic beta headers
- нативное управление Claude Desktop UI; proxy отвечает только за HTTP API

## Быстрый старт

```bash
cp .env.example .env
npm run auth
npm start
```

`npm run auth` откроет OAuth flow и сохранит токены в `.auth/codex.json`. Этот файл приватный, git его игнорирует.

Проверка:

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/models
```

Ожидаемо `/v1/models` возвращает только три модели:

```text
opus
sonnet
haiku
```

Так сделано специально: некоторые клиенты ломаются или неправильно пробуют gateway, если discovery возвращает слишком много Claude model ids.

## Настройка Claude Desktop как API gateway

Сначала запустите proxy:

```bash
npm start
```

В Claude Desktop настройте custom provider / gateway / Anthropic-compatible endpoint. Названия пунктов могут отличаться между версиями Claude Desktop, но значения должны быть такими:

| Поле | Значение |
| --- | --- |
| API type / provider | Anthropic-compatible / Claude Messages API |
| Base URL / Endpoint | `http://127.0.0.1:8787` |
| API key | любое непустое значение, например `local` |
| Model | `opus`, `sonnet` или `haiku` |

Важно: указывайте root URL `http://127.0.0.1:8787`, если клиент сам добавляет `/v1/messages`. Если конкретный UI просит полный endpoint, используйте `http://127.0.0.1:8787/v1/messages`.

Если в `.env` задан `PROXY_API_KEY`, то в Claude Desktop нужно указать именно это значение. Proxy принимает его как `x-api-key` или `Authorization: Bearer`.

Рекомендуемый первый тест в Claude Desktop:

```text
model: haiku
message: ответь одним коротким предложением, что соединение работает
```

Если модельный probe в Claude Desktop пишет `Gateway rejected model "haiku"`, проверьте:

```bash
curl -s http://127.0.0.1:8787/v1/models/haiku
curl -s http://127.0.0.1:8787/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -d '{"model":"haiku","messages":[{"role":"user","content":"ping"}]}'
```

## Настройка Claude Desktop plugin

В репозитории есть отдельный plugin package:

```text
claude-plugin/anthropic-proxy
```

Готовый архив:

```text
claude-plugin/anthropic-proxy-plugin.zip
```

Установите его как custom plugin через UI Claude Desktop: откройте настройки / Customize / Plugins и загрузите zip-файл. По документации Anthropic, custom plugins в Claude Desktop сохраняются локально на компьютере.

После установки в chat должны появиться skills:

```text
/anthropic-proxy:plugin
/anthropic-proxy:status
/anthropic-proxy:models
/anthropic-proxy:debug
```

Плагин не заменяет API gateway. Он только добавляет helper skills и MCP diagnostics для локального proxy.

Нативную команду Claude `/plugin` этот проект не переопределяет: это команда самого Claude. Для нашего пакета используется namespace `/anthropic-proxy:*`.

Для Claude Code можно тестировать пакет напрямую:

```bash
claude --plugin-dir ./claude-plugin/anthropic-proxy
```

Если меняли файлы плагина, пересоберите zip:

```bash
cd claude-plugin
zip -r anthropic-proxy-plugin.zip anthropic-proxy
```

## Модели и роутинг

Discovery показывает только короткие aliases, но proxy принимает и полные Claude-like ids из `ANTHROPIC_MODELS`.

| Запрошено клиентом | Upstream model | Reasoning | Verbosity | Output budget |
| --- | --- | --- | --- | --- |
| `opus`, `best`, `default`, ids containing `opus` | `gpt-5.5` | `xhigh` | `low` | `8192` |
| `sonnet`, ids containing `sonnet` | `gpt-5.4` | `high` | `low` | `8192` |
| `haiku`, ids containing `haiku` | `gpt-5.4-mini` | `low` | `low` | `4096` |

В `UPSTREAM=codex` hard `max_output_tokens` не отправляется, потому что ChatGPT-backed Codex endpoint отклоняет этот параметр. Вместо этого proxy добавляет output budget в `instructions`.

В `UPSTREAM=openai` proxy отправляет clamped `max_output_tokens` в официальный `/v1/responses`.

## Контекст и count_tokens

Текущая конфигурация:

| Параметр | Значение |
| --- | --- |
| Raw context window | `400000` |
| Reserve | `32768` |
| Advertised/enforced input budget | `367232` |
| Output budget Opus/Sonnet | `8192` |
| Output budget Haiku | `4096` |

`/v1/messages/count_tokens` считает локальную приблизительную оценку. Она специально консервативна для русского/non-ASCII текста, tool schemas, tool results и image blocks. Это нужно, чтобы Claude Desktop начинал compaction раньше и не доводил upstream до отказа по контексту.

Если входной запрос превышает бюджет, proxy вернет явную ошибку:

```text
Context window exceeded
```

В этом случае начните новый чат или сделайте compaction/summary.

## OpenAI Platform mode

Если нужно ходить не через ChatGPT/Codex subscription, а через официальный OpenAI API:

```bash
UPSTREAM=openai OPENAI_API_KEY=sk-... npm start
```

Или в `.env`:

```dotenv
UPSTREAM=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

В этом режиме OAuth Codex не используется.

## Полезные curl-команды

Health:

```bash
curl -s http://127.0.0.1:8787/health
```

Models:

```bash
curl -s http://127.0.0.1:8787/v1/models
curl -s http://127.0.0.1:8787/v1/models/opus
```

Count tokens:

```bash
curl -s http://127.0.0.1:8787/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"ping"}]}'
```

Non-streaming message:

```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "sonnet",
    "max_tokens": 256,
    "messages": [
      {"role": "user", "content": "Say hello in one sentence"}
    ]
  }'
```

Streaming message:

```bash
curl -N http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "haiku",
    "stream": true,
    "max_tokens": 128,
    "messages": [
      {"role": "user", "content": "stream a short answer"}
    ]
  }'
```

## Основные настройки `.env`

| Переменная | Назначение |
| --- | --- |
| `HOST`, `PORT` | bind address, по умолчанию `127.0.0.1:8787` |
| `PROXY_API_KEY` | optional входная авторизация |
| `UPSTREAM` | `codex` или `openai` |
| `DEFAULT_MODEL` | fallback upstream model |
| `ANTHROPIC_DISCOVERY_MODELS` | модели, которые видит клиент в `/v1/models` |
| `ANTHROPIC_MODELS` | дополнительные accepted aliases/full ids |
| `CLAUDE_OPUS_MODEL` | upstream для Opus-family |
| `CLAUDE_SONNET_MODEL` | upstream для Sonnet-family |
| `CLAUDE_HAIKU_MODEL` | upstream для Haiku-family |
| `CLAUDE_*_REASONING_EFFORT` | reasoning effort по семействам |
| `CLAUDE_*_TEXT_VERBOSITY` | verbosity по семействам |
| `CODEX_CONTEXT_WINDOW_TOKENS` | raw upstream context window |
| `CODEX_CONTEXT_RESERVE_TOKENS` | reserve под output и погрешность |
| `CODEX_MAX_INPUT_TOKENS` | advertised/enforced input budget |
| `CLAUDE_*_MAX_OUTPUT_TOKENS` | advertised output budget |
| `TOKEN_ESTIMATE_MULTIPLIER` | safety multiplier для count_tokens |
| `IMAGE_TOKEN_ESTIMATE` | оценка image block без размеров |
| `MODEL_MAP` | exact overrides, например `claude-sonnet-4-6=gpt-5.4` |
| `CODEX_AUTH_FILE` | путь к OAuth token file |
| `CODEX_INSTRUCTIONS` | fallback instructions для Codex |

## Troubleshooting

### Порт занят или сервер старый

Проверить listener:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Остановить старый процесс:

```bash
kill <PID>
npm start
```

После изменения `.env` или кода сервер нужно перезапускать.

### `Unsupported parameter: max_output_tokens`

Почти всегда это старый запущенный сервер. Новая Codex-ветка не отправляет `max_output_tokens`.

Проверьте listener, остановите старый PID и запустите `npm start`.

### `Instructions are required`

Старый сервер не добавлял fallback `CODEX_INSTRUCTIONS`. Перезапустите proxy.

### `Unexpected token 'e', "event: res"... is not valid JSON`

Старый сервер пытался парсить upstream SSE как JSON. Перезапустите proxy.

### `Unsupported message role: system`

Старый сервер не переносил `system` / `developer` messages в `instructions`. Перезапустите proxy.

### `Gateway rejected model "haiku"`

Проверьте:

```bash
curl -s http://127.0.0.1:8787/v1/models/haiku
```

Если endpoint работает, в Claude Desktop выберите модель `haiku`, а не полный model id. Если не работает, проверьте listener и `.env`.

### Чат перестает продолжаться

Возможные причины:

- клиент не сделал compaction вовремя
- upstream отказал из-за контекста или quota
- streaming error был скрыт старой версией proxy

Проверьте, что `/v1/models` показывает `max_input_tokens: 367232`, а не `400000`. Если все еще `400000`, работает старый процесс.

### `Context window exceeded`

Это уже явный guard proxy. Начните новый чат или попросите Claude Desktop/клиент сжать историю.

### OAuth истек или upstream отвечает 401/403

Повторите авторизацию:

```bash
npm run auth
npm start
```

## Безопасность

- Не публикуйте proxy наружу без `PROXY_API_KEY`.
- Не коммитьте `.auth/codex.json`.
- Не логируйте access/refresh tokens.
- Лучше держать `HOST=127.0.0.1`.

## Проверки перед использованием

```bash
npm run check
npm test
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/models
```

## Ссылки

- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- Anthropic streaming messages: https://docs.anthropic.com/en/api/messages-streaming
- Claude plugins in Claude Desktop: https://support.claude.com/en/articles/13837440-use-plugins-in-claude
- Claude Code plugins reference: https://code.claude.com/docs/en/plugins-reference
- Claude Code plugin creation guide: https://code.claude.com/docs/en/plugins
- Claude MCP overview: https://docs.anthropic.com/en/docs/mcp
