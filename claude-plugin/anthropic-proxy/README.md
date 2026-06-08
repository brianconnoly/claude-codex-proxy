# Anthropic Proxy Claude Plugin

Локальный Claude plugin для диагностики Anthropic-compatible GPT/Codex proxy.

Плагин не заменяет API gateway в Claude Desktop. Он добавляет helper skills и MCP tools, которые проверяют локальный proxy на `http://127.0.0.1:8787`.

## Skills

```text
/anthropic-proxy:plugin
/anthropic-proxy:status
/anthropic-proxy:models
/anthropic-proxy:debug
```

## MCP tools

- `anthropic_proxy_health`
- `anthropic_proxy_models`
- `anthropic_proxy_count_tokens`
- `anthropic_proxy_diagnostics`

По умолчанию MCP server использует:

```text
ANTHROPIC_PROXY_URL=http://127.0.0.1:8787
```

## Claude Desktop

1. Запустите proxy из корня проекта:

   ```bash
   npm start
   ```

2. Загрузите `anthropic-proxy-plugin.zip` как custom plugin в Claude Desktop.

3. В чате вызовите:

   ```text
   /anthropic-proxy:debug
   ```

Нативная команда `/plugin` принадлежит Claude. Этот пакет использует namespace `/anthropic-proxy:*`.

## Claude Code

Для локального тестирования:

```bash
claude --plugin-dir ./claude-plugin/anthropic-proxy
```

## Пересборка zip

Из корня репозитория:

```bash
cd claude-plugin
zip -r anthropic-proxy-plugin.zip anthropic-proxy
```
