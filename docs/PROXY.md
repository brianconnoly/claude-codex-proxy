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

В Claude Desktop нужно включить Developer Mode и настроить third-party inference. Это именно настройка inference/API gateway; она не связана с MCP extensions или plugin skills.

1. Откройте Claude Desktop, не web-версию `claude.ai`.
2. В верхнем меню включите Developer Mode:

   ```text
   Help -> Troubleshooting -> Enable Developer Mode
   ```

   В некоторых сборках тот же вход доступен через:

   ```text
   Settings -> Developer
   ```

3. Полностью перезапустите Claude Desktop, если приложение попросит это сделать.
4. Откройте появившееся меню:

   ```text
   Developer -> Configure third-party inference
   ```

5. В разделе connection/provider выберите:

   ```text
   Gateway (Anthropic-compatible)
   ```

6. Заполните значения:

| Поле | Значение |
| --- | --- |
| Gateway base URL / Base URL | `http://127.0.0.1:8787` |
| API key | `local`, если `PROXY_API_KEY` пустой |
| Auth scheme | `x-api-key` или `Bearer`, если UI просит выбрать |
| Models | `opus`, `sonnet`, `haiku` |

Важно: указывайте root URL `http://127.0.0.1:8787`, без `/v1`. Claude Desktop сам добавляет API paths вроде `/v1/messages`, `/v1/models` и `/v1/messages/count_tokens`. Полный endpoint `http://127.0.0.1:8787/v1/messages` нужен только если конкретный UI явно просит именно Messages endpoint.

Если в `.env` задан `PROXY_API_KEY`, то в Claude Desktop нужно указать именно это значение. Proxy принимает его как `x-api-key` или `Authorization: Bearer`.

Для Codex-backed контекста не задавайте `supports1m: true` и не отключайте model discovery. `Test model discovery` должен успешно ходить в `/v1/models`, но GUI Claude Desktop может все равно показывать стандартное Claude-like окно `200k`. Это UI-level bucket в Cowork/Claude Desktop; надежная проверка proxy-лимита - прямой запрос к `/v1/models`, где должно быть `max_input_tokens: 340000`.

7. Нажмите `Apply locally` / `Save`.
8. Полностью перезапустите Claude Desktop.

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
| Advertised input budget for Claude Desktop | `340000` |
| Hard input budget before trimming/error | `360000` |
| Retry input budget after upstream context error | `300000` |
| Hard reserve | `40000` |
| Proxy compact model | `gpt-5.4-mini` |
| Proxy compact summary budget | `2048` |
| Proxy compact trigger | `260000` |
| Proxy compact target | `220000` |
| Output budget Opus/Sonnet | `8192` |
| Output budget Haiku | `4096` |

Есть три разных входных лимита:

- `CODEX_MAX_INPUT_TOKENS` - soft/advertised budget. Его видит Claude Desktop в `/v1/models`, чтобы заранее запускать compaction.
- `CODEX_HARD_INPUT_TOKENS` - hard budget proxy перед отправкой в upstream. Он ближе к реальному окну `400000` и защищает от настоящего overflow.
- `CODEX_RETRY_INPUT_TOKENS` - более агрессивный budget для автоматического повторного запроса, если upstream все равно ответил `context window exceeded`.

`/v1/messages/count_tokens` считает локальную приблизительную оценку. Она специально консервативна для русского/non-ASCII текста, tool schemas, tool results и image blocks. Это нужно, чтобы Claude Desktop начинал compaction раньше.

Важно: Claude Desktop может показывать `200k` в интерфейсе даже когда gateway discovery возвращает `max_input_tokens: 340000`. По публичной конфигурации Cowork on 3P есть обычная Claude-like модель и отдельный `supports1m` вариант, но нет документированного способа выставить произвольное GUI-окно вроде `340k`. Поэтому native compaction нельзя считать надежной частью gateway-протокола.

Proxy-side compaction теперь запускается раньше advertised window: при `CONTEXT_COMPACT_TRIGGER_TOKENS=260000` proxy пытается сжать старый префикс истории до `CONTEXT_COMPACT_TARGET_TOKENS=220000`. Это отдельная страховка от ситуации, где Claude Desktop дошел до 280k+ и не сделал native compact.

Если Claude Desktop прислал историю выше compact trigger или soft budget, proxy не отвечает 400 сразу. Сначала он пытается сжать старый префикс истории отдельным дешевым запросом в `CONTEXT_COMPACT_MODEL` (`gpt-5.4-mini` по умолчанию), вставляет summary первым synthetic user message и сохраняет свежий хвост истории как raw messages.

Claude Desktop этот compact не видит как native compaction: на следующем turn он снова пришлет свою локальную историю. Поэтому proxy кеширует summaries in-memory по fingerprint сжатого префикса (`CONTEXT_COMPACT_CACHE_SIZE`), чтобы не пересжимать один и тот же старый блок каждый раз.

Если compact не помог или summary-запрос не удался, а `CONTEXT_OVERFLOW_STRATEGY=trim`, proxy возвращается к аварийному raw trimming и удаляет самые старые сообщения, пока запрос не станет помещаться. При trimming/compaction:

- сохраняется последний пользовательский контекст;
- история не начинается с orphan `tool_result`;
- в upstream `instructions` добавляется короткая заметка, что старые сообщения были сжаты или удалены;
- при successful compact модель получает summary ранних деталей, но Claude Desktop не обновляет свою локальную историю.

Если upstream уже после отправки отвечает ошибкой вида `Your input exceeds the context window of this model`, proxy делает один автоматический retry: берет исходный запрос, пытается compact до `CODEX_RETRY_INPUT_TOKENS`, а если compact не удался - делает raw trim и отправляет заново. Это нужно потому, что ChatGPT-backed Codex endpoint имеет скрытый overhead, который нельзя точно посчитать локально.

Если даже после trimming запрос не помещается, proxy вернет:

```text
Context window exceeded
```

В этом случае последний turn сам слишком большой или слишком тяжелые `tools`/images. Начните новый чат или сделайте compaction/summary.

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
| `CODEX_CONTEXT_RESERVE_TOKENS` | hard reserve под output, hidden overhead и погрешность |
| `CODEX_MAX_INPUT_TOKENS` | soft/advertised input budget для клиента |
| `CODEX_HARD_INPUT_TOKENS` | hard budget перед trimming/error |
| `CODEX_RETRY_INPUT_TOKENS` | aggressive retry budget после upstream context error |
| `CLAUDE_*_MAX_OUTPUT_TOKENS` | advertised output budget |
| `TOKEN_ESTIMATE_MULTIPLIER` | safety multiplier для count_tokens |
| `IMAGE_TOKEN_ESTIMATE` | оценка image block без размеров |
| `CONTEXT_OVERFLOW_STRATEGY` | `trim` или `error` |
| `CONTEXT_TRIM_NOTICE` | добавлять notice в instructions после trimming |
| `CONTEXT_COMPACT_ENABLED` | сжимать старый префикс перед raw trimming |
| `CONTEXT_COMPACT_MODEL` | модель для proxy-side summary |
| `CONTEXT_COMPACT_MAX_OUTPUT_TOKENS` | output budget summary-запроса |
| `CONTEXT_COMPACT_SUMMARY_TOKENS` | reserved summary budget при выборе префикса |
| `CONTEXT_COMPACT_TRIGGER_TOKENS` | ранний trigger proxy-side summary |
| `CONTEXT_COMPACT_TARGET_TOKENS` | target budget после proxy-side summary |
| `CONTEXT_COMPACT_CACHE_SIZE` | размер in-memory cache для summaries |
| `PROMPT_CACHE_KEY_MODE` | `anthropic` включает bridge из `cache_control` в upstream `prompt_cache_key`, `off` отключает |
| `PROMPT_CACHE_RETENTION` | optional upstream retention: пусто, `in_memory`, или `24h` |
| `MODEL_MAP` | exact overrides, например `claude-sonnet-4-6=gpt-5.4` |
| `CODEX_AUTH_FILE` | путь к OAuth token file |
| `CODEX_INSTRUCTIONS` | fallback instructions для Codex |

## Prompt Caching

Claude clients may send Anthropic `cache_control` markers on system/content/tool blocks. With `PROMPT_CACHE_KEY_MODE=anthropic`, the proxy canonicalizes the marked prefix, strips `cache_control` from the upstream payload, and sends a deterministic OpenAI/Codex `prompt_cache_key`.

If the upstream rejects `prompt_cache_key` or `prompt_cache_retention`, the proxy retries the same request once without prompt cache parameters. When upstream usage includes cached-token details, the Anthropic response usage includes `cache_read_input_tokens` and, if available, `cache_creation_input_tokens`. Non-zero cache usage is also logged by the proxy.

`usage.input_tokens` is reported as the original full request estimate before proxy-side compact/trim. This keeps Claude-facing usage aligned with the context volume Claude sent, while `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` still come from the final upstream response after any proxy-side compaction.

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

Проверьте, что `/v1/models` показывает `max_input_tokens: 340000`, а не `400000`, `367232`, `320000` или `250000`. Если значение старое, работает старый процесс.

### `Context window exceeded`

Это hard guard proxy. Сначала убедитесь, что сервер перезапущен и в `.env` есть актуальные более безопасные значения:

```dotenv
CODEX_MAX_INPUT_TOKENS=340000
CODEX_HARD_INPUT_TOKENS=360000
CODEX_RETRY_INPUT_TOKENS=300000
TOKEN_ESTIMATE_MULTIPLIER=1.3
CONTEXT_OVERFLOW_STRATEGY=trim
CONTEXT_COMPACT_ENABLED=true
CONTEXT_COMPACT_MODEL=gpt-5.4-mini
CONTEXT_COMPACT_MAX_OUTPUT_TOKENS=2048
CONTEXT_COMPACT_SUMMARY_TOKENS=2048
CONTEXT_COMPACT_TRIGGER_TOKENS=260000
CONTEXT_COMPACT_TARGET_TOKENS=220000
```

Если ошибка остается после перезапуска, значит последний запрос слишком большой даже после compaction/trimming или upstream отклоняет модель с меньшим фактическим окном. Временно уменьшите `CODEX_MAX_INPUT_TOKENS` и `CODEX_RETRY_INPUT_TOKENS`, затем перезапустите proxy.

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
- Claude Desktop local extensions and Developer settings: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- Claude Desktop remote vs desktop connectors: https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors
- Claude plugins in Claude Desktop: https://support.claude.com/en/articles/13837440-use-plugins-in-claude
- Claude Code plugins reference: https://code.claude.com/docs/en/plugins-reference
- Claude Code plugin creation guide: https://code.claude.com/docs/en/plugins
- Claude MCP overview: https://docs.anthropic.com/en/docs/mcp
