import { AnthropicError, estimateAnthropicTokens } from "./anthropic.js";

const DEFAULT_SUMMARY_TOKEN_BUDGET = 2048;

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? "") ?? "";
  } catch {
    return String(value ?? "");
  }
}

function renderContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return String(part ?? "");

  if (part.type === "text") return part.text ?? "";
  if (part.type === "image") {
    const mediaType = part.source?.media_type ?? "unknown";
    return `[image: ${mediaType}]`;
  }
  if (part.type === "tool_use") {
    return [
      `[tool_use: ${part.name ?? "unknown"} id=${part.id ?? "unknown"}]`,
      safeStringify(part.input ?? {}),
    ].join("\n");
  }
  if (part.type === "tool_result") {
    const output = typeof part.content === "string"
      ? part.content
      : safeStringify(part.content ?? "");
    return [
      `[tool_result id=${part.tool_use_id ?? "unknown"}]`,
      output,
    ].join("\n");
  }
  return safeStringify(part);
}

function renderMessageContent(content) {
  if (typeof content === "string") return content;
  return asArray(content).map(renderContentPart).filter(Boolean).join("\n");
}

function contentHasToolResult(content) {
  return asArray(content).some((part) => part?.type === "tool_result");
}

function removeOldestContextGroup(messages) {
  const removed = [];
  if (!messages.length) return removed;

  removed.push(messages.shift());
  while (messages.length > 1) {
    const first = messages[0];
    if (first?.role === "assistant") {
      removed.push(messages.shift());
      continue;
    }
    if (first?.role === "user" && contentHasToolResult(first.content)) {
      removed.push(messages.shift());
      continue;
    }
    break;
  }
  return removed;
}

function placeholderForBudget(summaryTokenBudget) {
  const tokenBudget = Number.isFinite(summaryTokenBudget) && summaryTokenBudget > 0
    ? summaryTokenBudget
    : DEFAULT_SUMMARY_TOKEN_BUDGET;
  return "x".repeat(Math.ceil(tokenBudget * 4));
}

export function createCompactSummaryMessage(summary) {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "[Earlier conversation summary inserted by local gateway]",
          String(summary ?? "").trim(),
        ].filter(Boolean).join("\n"),
      },
    ],
  };
}

export function renderMessagesForCompactSummary(messages) {
  return messages
    .map((message, index) => {
      const role = message?.role ?? "unknown";
      const content = renderMessageContent(message?.content);
      return `Message ${index + 1} (${role}):\n${content}`;
    })
    .join("\n\n");
}

export function truncateCompactSummary(summary, maxChars) {
  const text = String(summary ?? "").trim();
  if (!Number.isFinite(maxChars) || maxChars < 1 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[summary truncated]`;
}

export function selectAnthropicCompactContext(body, maxInputTokens, options = {}) {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens < 1) {
    throw new AnthropicError(500, "api_error", "Invalid context compact budget");
  }

  const originalTokens = estimateAnthropicTokens(body, options);
  if (!Array.isArray(body?.messages) || body.messages.length <= 1) {
    return {
      body,
      compactedMessages: [],
      tailMessages: body?.messages ?? [],
      originalTokens,
      inputTokens: originalTokens,
      removedMessages: 0,
      compacted: false,
      exceeded: originalTokens > maxInputTokens,
    };
  }

  const compactedMessages = [];
  const tailMessages = body.messages.slice();
  const summaryMessage = createCompactSummaryMessage(
    options.summaryPlaceholder ?? placeholderForBudget(options.summaryTokenBudget),
  );

  if (options.forceCompactOldest && tailMessages.length > 1) {
    compactedMessages.push(...removeOldestContextGroup(tailMessages));
  }

  let inputTokens = estimateAnthropicTokens(
    { ...body, messages: [summaryMessage, ...tailMessages] },
    options,
  );

  while (tailMessages.length > 1 && inputTokens > maxInputTokens) {
    compactedMessages.push(...removeOldestContextGroup(tailMessages));
    inputTokens = estimateAnthropicTokens(
      { ...body, messages: [summaryMessage, ...tailMessages] },
      options,
    );
  }

  return {
    body: { ...body, messages: [summaryMessage, ...tailMessages] },
    compactedMessages,
    tailMessages,
    originalTokens,
    inputTokens,
    removedMessages: compactedMessages.length,
    compacted: compactedMessages.length > 0,
    exceeded: inputTokens > maxInputTokens,
  };
}

export function applyAnthropicCompactSummary(body, selection, summary, maxInputTokens, options = {}) {
  if (!selection?.compacted) {
    return {
      body,
      originalTokens: selection?.originalTokens ?? estimateAnthropicTokens(body, options),
      inputTokens: selection?.inputTokens ?? estimateAnthropicTokens(body, options),
      removedMessages: 0,
      compacted: false,
    };
  }

  const summaryMessage = createCompactSummaryMessage(summary);
  const messages = [summaryMessage, ...selection.tailMessages];
  const compactedBody = { ...body, messages };
  const inputTokens = estimateAnthropicTokens(compactedBody, options);

  return {
    body: compactedBody,
    originalTokens: selection.originalTokens,
    inputTokens,
    removedMessages: selection.removedMessages,
    compacted: true,
    exceeded: inputTokens > maxInputTokens,
  };
}
