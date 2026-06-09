const DOUBLE_NEWLINE = /\r?\n\r?\n/;

export function encodeSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function readSseEvents(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (DOUBLE_NEWLINE.test(buffer)) {
      const [raw, ...rest] = buffer.split(DOUBLE_NEWLINE);
      buffer = rest.join("\n\n");
      await processRawEvent(raw, onEvent);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) await processRawEvent(buffer, onEvent);
}

async function processRawEvent(raw, onEvent) {
  let event = "message";
  const dataLines = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") return;
  await onEvent({ event, data });
}

export async function parseResponsesSse(response) {
  let finalResponse = null;
  let failedResponse = null;
  let rawText = "";
  let text = "";
  const functionCalls = new Map();

  const upsertFunctionCall = (item, outputIndex) => {
    const key = item?.id ?? item?.call_id ?? String(outputIndex);
    const existing = functionCalls.get(key) ?? {
      type: "function_call",
      id: item?.id,
      call_id: item?.call_id,
      name: item?.name,
      arguments: "",
    };

    if (item?.id) existing.id = item.id;
    if (item?.call_id) existing.call_id = item.call_id;
    if (item?.name) existing.name = item.name;
    if (typeof item?.arguments === "string") existing.arguments = item.arguments;

    functionCalls.set(key, existing);
    if (outputIndex != null) functionCalls.set(String(outputIndex), existing);
    return existing;
  };

  await readSseEvents(response.body, async ({ data }) => {
    rawText += `data: ${data}\n\n`;
    try {
      const json = JSON.parse(data);
      if (json.type === "response.output_text.delta" && json.delta) {
        text += json.delta;
      }
      if (json.type === "response.output_text.done" && json.text && !text) {
        text = json.text;
      }
      if (json.type === "response.output_item.added" && json.item?.type === "function_call") {
        upsertFunctionCall(json.item, json.output_index);
      }
      if (json.type === "response.function_call_arguments.delta") {
        const item =
          functionCalls.get(json.item_id) ??
          functionCalls.get(String(json.output_index));
        if (item) item.arguments += json.delta ?? "";
      }
      if (json.type === "response.output_item.done" && json.item?.type === "function_call") {
        upsertFunctionCall(json.item, json.output_index);
      }
      if (
        json.type === "response.completed" ||
        json.type === "response.done"
      ) {
        finalResponse = json.response ?? finalResponse;
      }
      if (json.type === "response.failed") {
        failedResponse = json.response ?? json;
      }
    } catch {
      // Ignore malformed events and continue.
    }
  });

  if (failedResponse) {
    const message =
      failedResponse?.error?.message ??
      failedResponse?.last_error?.message ??
      "Upstream response failed";
    throw new Error(message);
  }

  const output = reconstructedOutput(text, functionCalls);
  if (finalResponse) {
    return mergeReconstructedOutput(finalResponse, output);
  }

  if (output.length) return { output };

  throw new Error(`No final response event found in upstream SSE: ${rawText.slice(0, 1000)}`);
}

function reconstructedOutput(text, functionCalls) {
  const output = [];
  if (text) {
    output.push({
      type: "message",
      content: [{ type: "output_text", text }],
    });
  }

  for (const call of new Set(functionCalls.values())) {
    output.push(call);
  }
  return output;
}

function outputHasText(output) {
  return output.some((item) =>
    item?.type === "message" &&
    (item.content ?? []).some((part) =>
      part?.type === "output_text" && (part.text ?? part.output_text),
    ),
  );
}

function mergeReconstructedOutput(response, reconstructed) {
  if (!reconstructed.length) return response;

  const output = Array.isArray(response?.output) ? response.output.slice() : [];
  const seenCalls = new Set(
    output
      .filter((item) => item?.type === "function_call")
      .map((item) => item.call_id ?? item.id)
      .filter(Boolean),
  );
  const hasText = outputHasText(output);

  for (const item of reconstructed) {
    if (item.type === "message") {
      if (!hasText) output.push(item);
      continue;
    }

    if (item.type === "function_call") {
      const key = item.call_id ?? item.id;
      if (key && seenCalls.has(key)) continue;
      output.push(item);
      if (key) seenCalls.add(key);
    }
  }

  return { ...response, output };
}
