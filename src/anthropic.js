import crypto from "node:crypto";

const INPUT_TEXT = "input_text";
const OUTPUT_TEXT = "output_text";

export class AnthropicError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "tool_result") {
        return typeof part.content === "string"
          ? part.content
          : JSON.stringify(part.content ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultOutput(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = textFromContent(content);
    return text || JSON.stringify(content);
  }
  return JSON.stringify(content ?? "");
}

function contentPartToOpenAI(part, role) {
  if (typeof part === "string") {
    return { type: role === "assistant" ? OUTPUT_TEXT : INPUT_TEXT, text: part };
  }

  if (!part || typeof part !== "object") {
    return { type: role === "assistant" ? OUTPUT_TEXT : INPUT_TEXT, text: String(part ?? "") };
  }

  if (part.type === "text") {
    return { type: role === "assistant" ? OUTPUT_TEXT : INPUT_TEXT, text: part.text ?? "" };
  }

  if (part.type === "image" && part.source?.type === "base64") {
    return {
      type: "input_image",
      image_url: `data:${part.source.media_type};base64,${part.source.data}`,
    };
  }

  return {
    type: role === "assistant" ? OUTPUT_TEXT : INPUT_TEXT,
    text: textFromContent([part]),
  };
}

function convertMessage(message) {
  if (!message || typeof message !== "object") {
    throw new AnthropicError(400, "invalid_request_error", "Each message must be an object");
  }

  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    throw new AnthropicError(400, "invalid_request_error", `Unsupported message role: ${role}`);
  }

  const content = asArray(message.content);
  const items = [];
  const textParts = [];

  for (const part of content) {
    if (role === "user" && part?.type === "tool_result") {
      items.push({
        type: "function_call_output",
        call_id: part.tool_use_id,
        output: toolResultOutput(part.content),
      });
      continue;
    }

    if (role === "assistant" && part?.type === "tool_use") {
      if (textParts.length) {
        items.push({ role, content: textParts.splice(0) });
      }
      items.push({
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      });
      continue;
    }

    textParts.push(contentPartToOpenAI(part, role));
  }

  if (textParts.length) {
    items.push({ role, content: textParts });
  }

  return items;
}

function splitMessages(messages) {
  const input = [];
  const instructions = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      throw new AnthropicError(400, "invalid_request_error", "Each message must be an object");
    }

    if (message.role === "system" || message.role === "developer") {
      const text = textFromContent(message.content);
      if (text) instructions.push(text);
      continue;
    }

    input.push(...convertMessage(message));
  }

  return { input, instructions };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.input_schema ?? { type: "object", properties: {} },
    strict: false,
  }));
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", name: toolChoice.name };
  }
  return undefined;
}

function stripClaudeSuffixes(model) {
  return String(model ?? "")
    .toLowerCase()
    .replace(/\[1m\]$/, "");
}

export function resolveAnthropicFamily(model) {
  const normalized = stripClaudeSuffixes(model);
  if (normalized === "default" || normalized === "best" || normalized === "opus" || normalized.includes("opus")) {
    return "opus";
  }
  if (normalized === "sonnet" || normalized.includes("sonnet")) {
    return "sonnet";
  }
  if (normalized === "haiku" || normalized.includes("haiku")) {
    return "haiku";
  }
  return null;
}

export function resolveModelProfile(model, config) {
  const family = resolveAnthropicFamily(model);
  const profile = family ? config.modelProfiles?.[family] : null;
  const maxOutputTokens =
    family === "opus"
      ? config.limits?.opusMaxOutputTokens
      : family === "haiku"
        ? config.limits?.haikuMaxOutputTokens
        : config.limits?.sonnetMaxOutputTokens;
  let targetModel;

  if (model && config.modelMap.has(model)) {
    targetModel = config.modelMap.get(model);
  } else if (profile?.model) {
    targetModel = profile.model;
  } else if (model?.startsWith("openai/")) {
    targetModel = model.slice("openai/".length);
  } else if (model?.startsWith("gpt-") || model?.startsWith("codex")) {
    targetModel = model;
  } else {
    targetModel = config.defaultModel;
  }

  return {
    family,
    model: targetModel,
    reasoningEffort: profile?.reasoningEffort ?? config.request.reasoningEffort,
    reasoningSummary: profile?.reasoningSummary ?? config.request.reasoningSummary,
    textVerbosity: profile?.textVerbosity ?? config.request.textVerbosity,
    maxOutputTokens: maxOutputTokens ?? 8192,
  };
}

export function resolveModel(model, config) {
  return resolveModelProfile(model, config).model;
}

function renderFallbackInstructions(template, body, modelProfile) {
  const now = new Date();
  const currentDate = now.toISOString().slice(0, 10);
  return String(template ?? "")
    .replaceAll("{{current_date}}", currentDate)
    .replaceAll("{{requested_model}}", String(body?.model ?? ""))
    .replaceAll("{{upstream_model}}", String(modelProfile.model ?? ""))
    .replaceAll("{{model_family}}", String(modelProfile.family ?? ""));
}

function resolveMaxOutputTokens(body, modelProfile) {
  const cap = modelProfile.maxOutputTokens;
  const requested = Number.isFinite(body.max_tokens) ? body.max_tokens : cap;
  return Math.max(1, Math.min(requested, cap));
}

function appendInstructions(base, addition) {
  const cleanAddition = String(addition ?? "").trim();
  if (!cleanAddition) return base;
  const cleanBase = String(base ?? "").trim();
  return cleanBase ? `${cleanBase}\n\n${cleanAddition}` : cleanAddition;
}

function outputBudgetInstruction(body, modelProfile) {
  if (!Number.isFinite(body.max_tokens)) return "";
  const budget = resolveMaxOutputTokens(body, modelProfile);
  if (budget <= 128) {
    return `Output budget: answer as briefly as possible and stay within about ${budget} output tokens.`;
  }
  return `Output budget: stay within about ${budget} output tokens unless the user explicitly asks for more detail.`;
}

export function anthropicToResponses(body, config, options = {}) {
  if (!body || typeof body !== "object") {
    throw new AnthropicError(400, "invalid_request_error", "Request body must be JSON");
  }
  if (!Array.isArray(body.messages)) {
    throw new AnthropicError(400, "invalid_request_error", "messages must be an array");
  }

  const messageParts = splitMessages(body.messages);
  const modelProfile = resolveModelProfile(body.model, config);
  const systemText = asArray(body.system)
    .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
    .filter(Boolean)
    .concat(messageParts.instructions)
    .join("\n\n");

  const upstreamBody = {
    model: modelProfile.model,
    input: messageParts.input,
    stream: Boolean(options.forceStream || body.stream),
  };

  if (systemText) upstreamBody.instructions = systemText;
  if (Number.isFinite(body.max_tokens) && config.upstream !== "codex") {
    upstreamBody.max_output_tokens = resolveMaxOutputTokens(body, modelProfile);
  }
  if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
  if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) upstreamBody.stop = body.stop_sequences;

  const tools = convertTools(body.tools);
  if (tools?.length) upstreamBody.tools = tools;

  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice) upstreamBody.tool_choice = toolChoice;

  if (config.upstream === "codex") {
    if (!upstreamBody.instructions) {
      upstreamBody.instructions = renderFallbackInstructions(
        config.request.instructions,
        body,
        modelProfile,
      );
    }
    upstreamBody.store = false;
    upstreamBody.include = ["reasoning.encrypted_content"];
    upstreamBody.reasoning = {
      effort: modelProfile.reasoningEffort,
      summary: modelProfile.reasoningSummary,
    };
    upstreamBody.text = {
      verbosity: modelProfile.textVerbosity,
    };
    upstreamBody.instructions = appendInstructions(
      upstreamBody.instructions,
      outputBudgetInstruction(body, modelProfile),
    );
  }

  if (options.instructionsSuffix) {
    upstreamBody.instructions = appendInstructions(
      upstreamBody.instructions,
      options.instructionsSuffix,
    );
  }

  return upstreamBody;
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractOutput(response) {
  const content = [];

  for (const item of response?.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        const text = part.text ?? part.output_text ?? "";
        if (part.type === "output_text" && text) {
          content.push({ type: "text", text });
        }
      }
    }

    if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id ?? item.id ?? `toolu_${crypto.randomUUID()}`,
        name: item.name,
        input: safeJsonParse(item.arguments, {}),
      });
    }
  }

  return content;
}

function mapStopReason(response, content) {
  if (content.some((part) => part.type === "tool_use")) return "tool_use";
  if (response?.status === "incomplete") return "max_tokens";
  return "end_turn";
}

export function responsesToAnthropic(response, model) {
  const content = extractOutput(response);
  return {
    id: response?.id ?? `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(response, content),
    stop_sequence: null,
    usage: {
      input_tokens: response?.usage?.input_tokens ?? 0,
      output_tokens: response?.usage?.output_tokens ?? 0,
    },
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? "") ?? "";
  } catch {
    return String(value ?? "");
  }
}

function estimateTextTokens(value) {
  const text = String(value ?? "");
  if (!text) return 0;

  let asciiWordChars = 0;
  let asciiSymbolChars = 0;
  let asciiWhitespaceChars = 0;
  let nonAsciiChars = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      nonAsciiChars += code > 0xffff ? 2 : 1;
      continue;
    }

    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95
    ) {
      asciiWordChars += 1;
    } else if (code === 9 || code === 10 || code === 13 || code === 32) {
      asciiWhitespaceChars += 1;
    } else {
      asciiSymbolChars += 1;
    }
  }

  return Math.ceil(
    asciiWordChars / 4 +
      asciiSymbolChars / 2 +
      asciiWhitespaceChars / 8 +
      nonAsciiChars,
  );
}

function countContentTokens(content, options) {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return estimateTextTokens(content);

  let tokens = 0;
  const imageTokens = options?.imageTokens ?? 1024;

  for (const part of content) {
    tokens += 4;
    if (typeof part === "string") {
      tokens += estimateTextTokens(part);
      continue;
    }

    if (part?.type === "text") tokens += estimateTextTokens(part.text);
    else if (part?.type === "tool_use") {
      tokens += 12;
      tokens += estimateTextTokens(part.name);
      tokens += estimateTextTokens(safeStringify(part.input ?? {}));
    } else if (part?.type === "tool_result") {
      tokens += 12;
      tokens += estimateTextTokens(toolResultOutput(part.content));
    } else if (part?.type === "image") {
      tokens += imageTokens;
    } else {
      tokens += estimateTextTokens(safeStringify(part));
    }
  }
  return tokens;
}

export function estimateAnthropicTokens(body, options = {}) {
  let tokens = 16;

  for (const part of asArray(body?.system)) {
    tokens += 4;
    tokens += typeof part === "string"
      ? estimateTextTokens(part)
      : estimateTextTokens(part?.text ?? safeStringify(part));
  }

  for (const message of body?.messages ?? []) {
    tokens += 8;
    tokens += estimateTextTokens(message?.role);
    tokens += countContentTokens(message?.content, options);
  }

  for (const tool of body?.tools ?? []) {
    tokens += 32;
    tokens += estimateTextTokens(tool?.name);
    tokens += estimateTextTokens(tool?.description);
    tokens += estimateTextTokens(safeStringify(tool?.input_schema ?? {}));
  }

  const multiplier = Number.isFinite(options.multiplier) && options.multiplier > 0
    ? options.multiplier
    : 1;
  return Math.max(0, Math.ceil(tokens * multiplier));
}

function contentHasToolResult(content) {
  return asArray(content).some((part) => part?.type === "tool_result");
}

function dropUnsafeLeadingMessages(messages) {
  let dropped = 0;
  while (messages.length > 1) {
    const first = messages[0];
    if (first?.role === "assistant") {
      messages.shift();
      dropped += 1;
      continue;
    }
    if (first?.role === "user" && contentHasToolResult(first.content)) {
      messages.shift();
      dropped += 1;
      continue;
    }
    break;
  }
  return dropped;
}

export function trimAnthropicContext(body, maxInputTokens, options = {}) {
  const originalTokens = estimateAnthropicTokens(body, options);
  if (!Number.isFinite(maxInputTokens) || maxInputTokens < 1) {
    throw new AnthropicError(500, "api_error", "Invalid context trim budget");
  }
  if (originalTokens <= maxInputTokens) {
    return {
      body,
      originalTokens,
      inputTokens: originalTokens,
      removedMessages: 0,
      trimmed: false,
    };
  }

  if (!Array.isArray(body?.messages) || body.messages.length <= 1) {
    return {
      body,
      originalTokens,
      inputTokens: originalTokens,
      removedMessages: 0,
      trimmed: false,
      exceeded: true,
    };
  }

  const messages = body.messages.slice();
  let removedMessages = 0;
  let inputTokens = originalTokens;

  while (messages.length > 1 && inputTokens > maxInputTokens) {
    messages.shift();
    removedMessages += 1;
    removedMessages += dropUnsafeLeadingMessages(messages);
    inputTokens = estimateAnthropicTokens({ ...body, messages }, options);
  }

  return {
    body: { ...body, messages },
    originalTokens,
    inputTokens,
    removedMessages,
    trimmed: removedMessages > 0,
    exceeded: inputTokens > maxInputTokens,
  };
}

export function anthropicError(status, type, message) {
  return {
    status,
    body: {
      type: "error",
      error: { type, message },
    },
  };
}
