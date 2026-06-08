---
description: Inspect or explain the local Anthropic Proxy Claude plugin and available helper commands.
---

Use this skill when the user asks about this plugin, `/plugin`, available proxy helper commands, or how to verify that the plugin is installed.

Explain that Claude's native `/plugin` command is managed by Claude itself, while this package exposes namespaced commands:

- `/anthropic-proxy:status`
- `/anthropic-proxy:models`
- `/anthropic-proxy:debug`

If MCP tools are available, call `anthropic_proxy_diagnostics` and summarize whether the local proxy is reachable. Keep the answer concise and include the proxy URL.
