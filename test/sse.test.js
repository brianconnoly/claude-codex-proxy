import assert from "node:assert/strict";
import test from "node:test";
import { encodeSse, parseResponsesSse } from "../src/sse.js";

function sseResponse(events) {
  return new Response(events.join(""));
}

test("parses final Responses SSE event", async () => {
  const response = sseResponse([
    encodeSse("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      },
    }),
  ]);

  const result = await parseResponsesSse(response);
  assert.equal(result.id, "resp_1");
  assert.equal(result.output[0].content[0].text, "done");
});

test("reconstructs Responses SSE when final event is absent", async () => {
  const response = sseResponse([
    encodeSse("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: "hel",
    }),
    encodeSse("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: "lo",
    }),
    encodeSse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", call_id: "call_1", name: "read" },
    }),
    encodeSse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: "{\"path\":\"a",
    }),
    encodeSse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: "\"}",
    }),
  ]);

  const result = await parseResponsesSse(response);
  assert.deepEqual(result.output, [
    {
      type: "message",
      content: [{ type: "output_text", text: "hello" }],
    },
    {
      type: "function_call",
      id: undefined,
      call_id: "call_1",
      name: "read",
      arguments: "{\"path\":\"a\"}",
    },
  ]);
});

test("keeps reconstructed text when final Responses SSE output is empty", async () => {
  const response = sseResponse([
    encodeSse("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: "compact ",
    }),
    encodeSse("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: "summary",
    }),
    encodeSse("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_2",
        output: [],
      },
    }),
  ]);

  const result = await parseResponsesSse(response);
  assert.equal(result.id, "resp_2");
  assert.deepEqual(result.output, [
    {
      type: "message",
      content: [{ type: "output_text", text: "compact summary" }],
    },
  ]);
});

test("throws on failed Responses SSE event", async () => {
  const response = sseResponse([
    encodeSse("response.failed", {
      type: "response.failed",
      response: {
        status: "failed",
        error: { message: "context window exceeded" },
      },
    }),
  ]);

  await assert.rejects(
    () => parseResponsesSse(response),
    /context window exceeded/,
  );
});
