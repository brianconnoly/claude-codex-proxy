import http from "node:http";
import crypto from "node:crypto";
import { loadConfig, isLoopbackHost } from "./config.js";
import {
  AnthropicError,
  anthropicError,
  anthropicToResponses,
  estimateAnthropicTokens,
  resolveAnthropicFamily,
  resolveModelProfile,
  responsesToAnthropic,
} from "./anthropic.js";
import { callUpstream } from "./upstream.js";
import { encodeSse, parseResponsesSse, readSseEvents } from "./sse.js";

const config = loadConfig();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        reject(new AnthropicError(413, "request_too_large", "Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new AnthropicError(400, "invalid_request_error", "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  const status = error.status ?? 500;
  const type = error.type ?? (status >= 500 ? "api_error" : "invalid_request_error");
  const message = error.message ?? "Internal server error";
  const payload = anthropicError(status, type, message);
  sendJson(res, payload.status, payload.body);
}

function isAuthorized(req) {
  if (!config.proxyApiKey) return true;
  const xApiKey = req.headers["x-api-key"];
  const authorization = req.headers.authorization ?? "";
  return (
    xApiKey === config.proxyApiKey ||
    authorization === `Bearer ${config.proxyApiKey}`
  );
}

async function upstreamErrorToAnthropic(response) {
  const text = await response.text().catch(() => "");
  let message = text || response.statusText || "Upstream request failed";
  try {
    const parsed = JSON.parse(text);
    message =
      parsed?.error?.message ??
      parsed?.detail ??
      parsed?.message ??
      message;
  } catch {
    // Keep raw text.
  }
  return new AnthropicError(response.status, "api_error", message);
}

function estimateRequestInputTokens(body) {
  return estimateAnthropicTokens(body, config.tokenEstimate);
}

function assertContextBudget(body) {
  const inputTokens = estimateRequestInputTokens(body);
  const maxInputTokens = config.limits.maxInputTokens;
  if (inputTokens <= maxInputTokens) return inputTokens;

  throw new AnthropicError(
    400,
    "invalid_request_error",
    `Context window exceeded: estimated ${inputTokens} input tokens exceeds the configured ` +
      `${maxInputTokens} token input budget. Start a new chat or compact the conversation.`,
  );
}

async function handleMessages(req, res) {
  if (!isAuthorized(req)) {
    throw new AnthropicError(401, "authentication_error", "Invalid proxy API key");
  }

  const body = await readJson(req);
  assertContextBudget(body);
  const upstreamBody = anthropicToResponses(body, config, {
    forceStream: config.upstream === "codex",
  });
  const upstream = await callUpstream(config, upstreamBody);

  if (!upstream.ok) {
    throw await upstreamErrorToAnthropic(upstream);
  }

  if (body.stream) {
    await streamAnthropic(upstream, res, body.model ?? upstreamBody.model);
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const responsesBody = upstreamBody.stream || contentType.includes("text/event-stream")
    ? await parseResponsesSse(upstream)
    : await upstream.json();

  sendJson(res, 200, responsesToAnthropic(responsesBody, body.model ?? upstreamBody.model), {
    "request-id": crypto.randomUUID(),
  });
}

async function handleCountTokens(req, res) {
  if (!isAuthorized(req)) {
    throw new AnthropicError(401, "authentication_error", "Invalid proxy API key");
  }

  const body = await readJson(req);
  sendJson(res, 200, {
    input_tokens: estimateRequestInputTokens(body),
  });
}

function responseFailureMessage(json) {
  const failed = json?.response ?? json;
  return (
    failed?.error?.message ??
    failed?.last_error?.message ??
    json?.error?.message ??
    "Upstream response failed"
  );
}

async function streamAnthropic(upstream, res, model) {
  const messageId = `msg_${crypto.randomUUID()}`;
  let contentIndex = -1;
  let textOpen = false;
  let completed = null;
  let upstreamFailure = null;
  const toolBlocks = new Map();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const send = (event, data) => {
    res.write(encodeSse(event, data));
  };

  const openTextBlock = () => {
    if (textOpen) return;
    contentIndex += 1;
    textOpen = true;
    send("content_block_start", {
      type: "content_block_start",
      index: contentIndex,
      content_block: { type: "text", text: "" },
    });
  };

  const closeTextBlock = () => {
    if (!textOpen) return;
    send("content_block_stop", {
      type: "content_block_stop",
      index: contentIndex,
    });
    textOpen = false;
  };

  const openToolBlock = (item, outputIndex) => {
    const key = item.id ?? item.call_id ?? String(outputIndex);
    if (toolBlocks.has(key)) return toolBlocks.get(key);
    closeTextBlock();
    contentIndex += 1;
    const block = {
      index: contentIndex,
      id: item.call_id ?? item.id ?? `toolu_${crypto.randomUUID()}`,
      name: item.name,
      args: "",
      open: true,
    };
    toolBlocks.set(key, block);
    toolBlocks.set(String(outputIndex), block);
    send("content_block_start", {
      type: "content_block_start",
      index: block.index,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    });
    return block;
  };

  const closeToolBlock = (block) => {
    if (!block?.open) return;
    send("content_block_stop", {
      type: "content_block_stop",
      index: block.index,
    });
    block.open = false;
  };

  send("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  await readSseEvents(upstream.body, async ({ data }) => {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }

    if (json.type === "response.output_text.delta" && json.delta) {
      openTextBlock();
      send("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "text_delta", text: json.delta },
      });
      return;
    }

    if (json.type === "response.output_text.done") {
      closeTextBlock();
      return;
    }

    if (json.type === "response.output_item.added" && json.item?.type === "function_call") {
      openToolBlock(json.item, json.output_index);
      return;
    }

    if (json.type === "response.function_call_arguments.delta") {
      const block = toolBlocks.get(json.item_id) ?? toolBlocks.get(String(json.output_index));
      if (!block) return;
      block.args += json.delta ?? "";
      send("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: json.delta ?? "" },
      });
      return;
    }

    if (json.type === "response.output_item.done" && json.item?.type === "function_call") {
      const block = openToolBlock(json.item, json.output_index);
      if (!block.args && json.item.arguments) {
        block.args = json.item.arguments;
        send("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: json.item.arguments },
        });
      }
      closeToolBlock(block);
      return;
    }

    if (
      json.type === "response.completed" ||
      json.type === "response.done"
    ) {
      completed = json.response ?? {};
      if (completed?.status === "failed") upstreamFailure = responseFailureMessage(json);
      return;
    }

    if (json.type === "response.failed") {
      completed = json.response ?? {};
      upstreamFailure = responseFailureMessage(json);
    }
  });

  closeTextBlock();
  for (const block of new Set(toolBlocks.values())) closeToolBlock(block);

  if (upstreamFailure) {
    send("error", {
      type: "error",
      error: {
        type: "api_error",
        message: upstreamFailure,
      },
    });
    res.end();
    return;
  }

  const anthropicFinal = responsesToAnthropic(completed ?? {}, model);
  send("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: anthropicFinal.stop_reason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: anthropicFinal.usage.output_tokens,
    },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function displayNameForModel(model) {
  const family = resolveAnthropicFamily(model);
  if (!family) return model;

  const name = family[0].toUpperCase() + family.slice(1);
  return `Claude ${name}`;
}

function createdAtForModel(model) {
  if (model.includes("20251001")) return "2025-10-01T00:00:00Z";
  if (model.includes("20250929")) return "2025-09-29T00:00:00Z";
  if (model.includes("20250805")) return "2025-08-05T00:00:00Z";
  if (model.includes("20250514")) return "2025-05-14T00:00:00Z";
  if (model.includes("4-8")) return "2026-05-28T00:00:00Z";
  if (model.includes("4-7")) return "2026-04-16T00:00:00Z";
  if (model.includes("4-6")) return "2026-02-17T00:00:00Z";
  return "2025-01-01T00:00:00Z";
}

function maxOutputTokensForModel(model) {
  const family = resolveAnthropicFamily(model);
  if (family === "opus") return config.limits.opusMaxOutputTokens;
  if (family === "sonnet") return config.limits.sonnetMaxOutputTokens;
  if (family === "haiku") return config.limits.haikuMaxOutputTokens;
  return config.limits.sonnetMaxOutputTokens;
}

function maxInputTokensForModel() {
  return config.limits.maxInputTokens;
}

function modelInfo(id) {
  if (!config.anthropicModels.includes(id) && !resolveAnthropicFamily(id)) {
    return null;
  }

  const family = resolveAnthropicFamily(id);
  return {
    id,
    type: "model",
    display_name: displayNameForModel(id),
    created_at: createdAtForModel(id),
    max_input_tokens: maxInputTokensForModel(),
    max_tokens: maxOutputTokensForModel(id),
    capabilities: {
      input: ["text", "image"],
      output: ["text"],
      tools: true,
      thinking: family !== "haiku",
    },
  };
}

function handleModels(res) {
  const data = [];
  const seen = new Set();
  const addModel = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    data.push(modelInfo(id));
  };

  for (const model of config.discoveryModels) addModel(model);

  sendJson(res, 200, {
    data,
  });
}

function handleModelLookup(res, modelId) {
  const info = modelInfo(modelId);
  if (!info) {
    sendJson(res, 404, anthropicError(404, "not_found_error", "Model not found").body);
    return;
  }

  sendJson(res, 200, info);
}

async function router(req, res) {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, upstream: config.upstream });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      handleModels(res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      handleModelLookup(res, decodeURIComponent(url.pathname.slice("/v1/models/".length)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      await handleMessages(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      await handleCountTokens(req, res);
      return;
    }

    sendJson(res, 404, anthropicError(404, "not_found_error", "Not found").body);
  } catch (error) {
    sendError(res, error);
  }
}

if (!config.proxyApiKey && !isLoopbackHost(config.host)) {
  throw new Error("Set PROXY_API_KEY when HOST is not loopback");
}

const server = http.createServer(router);
server.listen(config.port, config.host, () => {
  const authNote = config.proxyApiKey ? "proxy auth enabled" : "proxy auth disabled";
  console.log(
    `Anthropic proxy listening on http://${config.host}:${config.port} (${config.upstream}, ${authNote})`,
  );
});
