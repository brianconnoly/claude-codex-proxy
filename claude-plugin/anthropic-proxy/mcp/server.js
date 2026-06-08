#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.ANTHROPIC_PROXY_URL || "http://127.0.0.1:8787";
const SERVER_NAME = "anthropic-proxy";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

const tools = [
  {
    name: "anthropic_proxy_health",
    description: "Check whether the local Anthropic proxy is reachable.",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: {
          type: "string",
          description: "Proxy base URL.",
          default: DEFAULT_BASE_URL
        }
      }
    }
  },
  {
    name: "anthropic_proxy_models",
    description: "List model aliases and token limits exposed by the local Anthropic proxy.",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: {
          type: "string",
          description: "Proxy base URL.",
          default: DEFAULT_BASE_URL
        }
      }
    }
  },
  {
    name: "anthropic_proxy_count_tokens",
    description: "Ask the proxy to estimate Anthropic input tokens for a request body.",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: {
          type: "string",
          description: "Proxy base URL.",
          default: DEFAULT_BASE_URL
        },
        request: {
          type: "object",
          description: "Anthropic /v1/messages-compatible request body."
        }
      }
    }
  },
  {
    name: "anthropic_proxy_diagnostics",
    description: "Run health, model discovery, and token-count diagnostics against the local proxy.",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: {
          type: "string",
          description: "Proxy base URL.",
          default: DEFAULT_BASE_URL
        }
      }
    }
  }
];

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {})
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    const raw = await response.text();
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // Keep raw text.
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || raw || response.statusText;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function callTool(name, args = {}) {
  const baseUrl = args.baseUrl || DEFAULT_BASE_URL;

  if (name === "anthropic_proxy_health") {
    return textResult(await requestJson(baseUrl, "/health"));
  }

  if (name === "anthropic_proxy_models") {
    return textResult(await requestJson(baseUrl, "/v1/models"));
  }

  if (name === "anthropic_proxy_count_tokens") {
    const request = args.request || {
      model: "sonnet",
      messages: [{ role: "user", content: "ping" }]
    };
    return textResult(await requestJson(baseUrl, "/v1/messages/count_tokens", {
      method: "POST",
      body: JSON.stringify(request)
    }));
  }

  if (name === "anthropic_proxy_diagnostics") {
    const diagnostics = {
      baseUrl: normalizeBaseUrl(baseUrl),
      health: null,
      models: null,
      countTokens: null,
      errors: []
    };

    for (const step of [
      ["health", () => requestJson(baseUrl, "/health")],
      ["models", () => requestJson(baseUrl, "/v1/models")],
      [
        "countTokens",
        () => requestJson(baseUrl, "/v1/messages/count_tokens", {
          method: "POST",
          body: JSON.stringify({
            model: "sonnet",
            messages: [{ role: "user", content: "ping" }]
          })
        })
      ]
    ]) {
      const [key, run] = step;
      try {
        diagnostics[key] = await run();
      } catch (error) {
        diagnostics.errors.push({ step: key, message: error.message });
      }
    }

    return textResult(diagnostics, diagnostics.errors.length > 0);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  process.stdout.write(header);
  process.stdout.write(body);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (message.id == null) return;

  try {
    if (message.method === "initialize") {
      sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
      return;
    }

    if (message.method === "ping") {
      sendResult(message.id, {});
      return;
    }

    if (message.method === "tools/list") {
      sendResult(message.id, { tools });
      return;
    }

    if (message.method === "tools/call") {
      const result = await callTool(
        message.params?.name,
        message.params?.arguments || {}
      );
      sendResult(message.id, result);
      return;
    }

    sendError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.message || "Tool call failed");
  }
}

let buffer = Buffer.alloc(0);

function readContentLength(headers) {
  const match = headers.match(/^content-length:\s*(\d+)$/im);
  return match ? Number.parseInt(match[1], 10) : null;
}

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
    if (headerEnd === -1) return;

    const headers = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = readContentLength(headers);
    if (!Number.isInteger(contentLength)) {
      buffer = Buffer.alloc(0);
      return;
    }

    const bodyStart = headerEnd + HEADER_SEPARATOR.length;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);

    try {
      void handle(JSON.parse(body));
    } catch {
      // Ignore malformed input that has no JSON-RPC id to answer.
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.resume();
