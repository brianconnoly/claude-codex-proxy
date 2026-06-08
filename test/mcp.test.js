import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

const serverPath = path.resolve("claude-plugin/anthropic-proxy/mcp/server.js");

function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function createReader(stream) {
  let buffer = Buffer.alloc(0);
  const queue = [];
  const waiters = [];

  function readContentLength(headers) {
    const match = headers.match(/^content-length:\s*(\d+)$/im);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function pump() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headers = buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = readContentLength(headers);
      assert.ok(Number.isInteger(contentLength));

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) return;

      const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      buffer = buffer.subarray(bodyEnd);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    }
  }

  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });

  return function readMessage() {
    const message = queue.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

test("Claude plugin MCP server initializes and lists tools", async () => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readMessage = createReader(child.stdout);

  child.stdin.write(encodeMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  }));
  const init = await readMessage();
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, "anthropic-proxy");

  child.stdin.write(encodeMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  }));
  const list = await readMessage();
  assert.equal(list.id, 2);
  assert.ok(list.result.tools.some((tool) => tool.name === "anthropic_proxy_diagnostics"));

  child.kill();
  await once(child, "exit");
});
