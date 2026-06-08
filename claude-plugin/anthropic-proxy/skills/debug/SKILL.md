---
description: Run diagnostics for model discovery, token counting, and local proxy reachability.
---

Call `anthropic_proxy_diagnostics`. Focus on actionable findings:

- whether `/health` works
- which models `/v1/models` advertises
- whether `/v1/messages/count_tokens` works
- whether token limits look sane for long conversations

If the diagnostics show an error, give the smallest next step that would unblock the user.
