import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicToResponses,
  estimateAnthropicTokens,
  resolveAnthropicFamily,
  resolveModelProfile,
  responsesToAnthropic,
  trimAnthropicContext,
} from "../src/anthropic.js";

const config = {
  upstream: "codex",
  defaultModel: "gpt-5.4",
  modelMap: new Map([["claude-sonnet-4-5", "gpt-5.4"]]),
  request: {
    instructions: [
      "You are an AI assistant served through an Anthropic Messages-compatible gateway.",
      "Current date: {{current_date}}.",
      "Requested model: {{requested_model}}.",
      "Upstream model: {{upstream_model}}.",
      "Family: {{model_family}}.",
    ].join("\n"),
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    textVerbosity: "medium",
  },
  modelProfiles: {
    opus: {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      reasoningSummary: "auto",
      textVerbosity: "low",
    },
    sonnet: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      textVerbosity: "low",
    },
    haiku: {
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      reasoningSummary: "auto",
      textVerbosity: "low",
    },
  },
  limits: {
    maxInputTokens: 400000,
    opusMaxOutputTokens: 8192,
    sonnetMaxOutputTokens: 8192,
    haikuMaxOutputTokens: 4096,
  },
};

test("converts Anthropic text request to Responses request", () => {
  const result = anthropicToResponses(
    {
      model: "claude-sonnet-4-5",
      system: "You are concise.",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    },
    config,
    { forceStream: true },
  );

  assert.equal(result.model, "gpt-5.4");
  assert.equal(
    result.instructions,
    "You are concise.\n\nOutput budget: answer as briefly as possible and stay within about 100 output tokens.",
  );
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
  assert.equal(result.max_output_tokens, undefined);
  assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(result.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(result.text, { verbosity: "low" });
  assert.deepEqual(result.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ]);
});

test("routes Claude families to configured GPT profiles", () => {
  assert.equal(resolveAnthropicFamily("claude-opus-4-8"), "opus");
  assert.equal(resolveAnthropicFamily("claude-sonnet-4-6[1m]"), "sonnet");
  assert.equal(resolveAnthropicFamily("claude-haiku-4-5"), "haiku");
  assert.equal(resolveAnthropicFamily("best"), "opus");

  const result = anthropicToResponses(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hello" }],
    },
    config,
  );

  assert.equal(result.model, "gpt-5.4-mini");
  assert.equal(result.max_output_tokens, undefined);
  assert.match(
    result.instructions,
    /You are an AI assistant served through an Anthropic Messages-compatible gateway\.\nCurrent date: \d{4}-\d{2}-\d{2}\./,
  );
  assert.match(result.instructions, /Requested model: claude-haiku-4-5\./);
  assert.match(result.instructions, /Upstream model: gpt-5\.4-mini\./);
  assert.match(result.instructions, /Family: haiku\./);
  assert.deepEqual(result.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(result.text, { verbosity: "low" });
});

test("adds Codex output budget without unsupported max_output_tokens", () => {
  const result = anthropicToResponses(
    {
      model: "haiku",
      max_tokens: 128000,
      messages: [{ role: "user", content: "hello" }],
    },
    config,
  );

  assert.equal(result.max_output_tokens, undefined);
  assert.match(
    result.instructions,
    /Output budget: stay within about 4096 output tokens unless the user explicitly asks for more detail\./,
  );
});

test("clamps OpenAI max_output_tokens to family cap", () => {
  const result = anthropicToResponses(
    {
      model: "haiku",
      max_tokens: 128000,
      messages: [{ role: "user", content: "hello" }],
    },
    { ...config, upstream: "openai" },
  );

  assert.equal(result.max_output_tokens, 4096);
  assert.equal(result.reasoning, undefined);
  assert.equal(result.text, undefined);
});

test("keeps provided system text above Codex fallback instructions", () => {
  const result = anthropicToResponses(
    {
      model: "haiku",
      system: "Follow this exact system prompt.",
      messages: [{ role: "user", content: "hello" }],
    },
    config,
  );

  assert.equal(result.instructions, "Follow this exact system prompt.");
});

test("moves system role messages into Responses instructions", () => {
  const result = anthropicToResponses(
    {
      model: "haiku",
      system: "Top-level system.",
      messages: [
        { role: "system", content: "Message-level system." },
        { role: "developer", content: [{ type: "text", text: "Developer note." }] },
        { role: "user", content: "hello" },
      ],
    },
    config,
  );

  assert.equal(
    result.instructions,
    "Top-level system.\n\nMessage-level system.\n\nDeveloper note.",
  );
  assert.deepEqual(result.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ]);
});

test("exact model map overrides target model but keeps Claude family profile", () => {
  const result = resolveModelProfile("claude-opus-4-8", {
    ...config,
    modelMap: new Map([["claude-opus-4-8", "gpt-5.4-pro"]]),
  });

  assert.equal(result.family, "opus");
  assert.equal(result.model, "gpt-5.4-pro");
  assert.equal(result.reasoningEffort, "xhigh");
});

test("converts Anthropic tool request blocks to Responses function items", () => {
  const result = anthropicToResponses(
    {
      model: "gpt-5.4",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
        },
      ],
    },
    config,
  );

  assert.deepEqual(result.input, [
    {
      type: "function_call",
      call_id: "call_1",
      name: "read",
      arguments: "{\"path\":\"a\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "ok",
    },
  ]);
});

test("converts Anthropic tool_result arrays to text output", () => {
  const result = anthropicToResponses(
    {
      model: "gpt-5.4",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "line one" },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      ],
    },
    config,
  );

  assert.deepEqual(result.input, [
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "line one\nline two",
    },
  ]);
});

test("converts Anthropic none tool choice", () => {
  const result = anthropicToResponses(
    {
      model: "gpt-5.4",
      tool_choice: { type: "none" },
      messages: [{ role: "user", content: "hello" }],
    },
    config,
  );

  assert.equal(result.tool_choice, "none");
});

test("converts Responses output to Anthropic message", () => {
  const result = responsesToAnthropic(
    {
      id: "resp_1",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hi" }],
        },
        {
          type: "function_call",
          call_id: "call_2",
          name: "write",
          arguments: "{\"path\":\"b\"}",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "gpt-5.4",
  );

  assert.equal(result.id, "resp_1");
  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.content, [
    { type: "text", text: "hi" },
    { type: "tool_use", id: "call_2", name: "write", input: { path: "b" } },
  ]);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

test("estimates Anthropic count_tokens response locally", () => {
  const result = estimateAnthropicTokens({
    system: "You are concise.",
    messages: [{ role: "user", content: "hello world" }],
    tools: [{ name: "read", input_schema: { type: "object" } }],
  });

  assert.equal(typeof result, "number");
  assert.ok(result > 0);
});

test("estimates non-ASCII conversations conservatively", () => {
  const ascii = estimateAnthropicTokens(
    { messages: [{ role: "user", content: "a".repeat(100) }] },
    { multiplier: 1 },
  );
  const russian = estimateAnthropicTokens(
    { messages: [{ role: "user", content: "я".repeat(100) }] },
    { multiplier: 1 },
  );

  assert.ok(russian > ascii * 2);
});

test("trims oldest Anthropic messages to fit a hard context budget", () => {
  const body = {
    model: "sonnet",
    messages: [
      { role: "user", content: "я".repeat(200) },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current question" },
    ],
  };

  const original = estimateAnthropicTokens(body, { multiplier: 1 });
  const result = trimAnthropicContext(body, 80, { multiplier: 1 });

  assert.equal(result.trimmed, true);
  assert.equal(result.exceeded, false);
  assert.ok(result.originalTokens > original - 1);
  assert.ok(result.inputTokens <= 80);
  assert.deepEqual(result.body.messages, [
    { role: "user", content: "current question" },
  ]);
});

test("context trimming does not leave a leading orphan tool_result", () => {
  const body = {
    model: "sonnet",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "old result" }],
      },
      { role: "user", content: "final question" },
    ],
  };

  const result = trimAnthropicContext(body, 40, { multiplier: 1 });

  assert.equal(result.trimmed, true);
  assert.equal(result.exceeded, false);
  assert.deepEqual(result.body.messages, [
    { role: "user", content: "final question" },
  ]);
});

test("forced context trimming removes old history even under target budget", () => {
  const body = {
    model: "sonnet",
    messages: [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current question" },
    ],
  };
  const original = estimateAnthropicTokens(body, { multiplier: 1 });
  const result = trimAnthropicContext(body, original + 100, {
    multiplier: 1,
    forceRemoveOldest: true,
  });

  assert.equal(result.trimmed, true);
  assert.equal(result.exceeded, false);
  assert.equal(result.removedMessages, 2);
  assert.deepEqual(result.body.messages, [
    { role: "user", content: "current question" },
  ]);
});
