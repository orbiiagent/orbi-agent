import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChat } from "../src/stream.ts";

// Build a fake server-sent-events response from OpenAI-style deltas.
function sse(deltas: object[]): Response {
  const body = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const realFetch = globalThis.fetch;
const run = (deltas: object[]) => {
  globalThis.fetch = (async () => sse(deltas)) as typeof fetch;
  return streamChat("http://x", {}, {}, () => {}).finally(() => (globalThis.fetch = realFetch));
};

test("a tool with no parameters gets '{}' arguments (the empty-string bug)", async () => {
  const r = await run([{ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "get_balances" } }] }, { tool_calls: [{ index: 0, function: { arguments: "" } }] }]);
  assert.equal(r.tool_calls.length, 1);
  assert.equal(r.tool_calls[0].function.arguments, "{}");
});

test("arguments streamed in pieces are joined into valid JSON", async () => {
  const r = await run([
    { tool_calls: [{ index: 0, id: "t2", type: "function", function: { name: "get_yields", arguments: '{"kind"' } }] },
    { tool_calls: [{ index: 0, function: { arguments: ': "lending"}' } }] },
  ]);
  assert.deepEqual(JSON.parse(r.tool_calls[0].function.arguments), { kind: "lending" });
});

test("broken argument JSON is replaced instead of poisoning the history", async () => {
  const r = await run([{ tool_calls: [{ index: 0, id: "t3", type: "function", function: { name: "get_prices", arguments: '{"symbols": [' } }] }]);
  assert.equal(r.tool_calls[0].function.arguments, "{}");
});

test("plain text deltas are collected and reported as they arrive", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async () => sse([{ content: "Hello " }, { content: "there." }])) as typeof fetch;
  const r = await streamChat("http://x", {}, {}, (d) => seen.push(d)).finally(() => (globalThis.fetch = realFetch));
  assert.equal(r.content, "Hello there.");
  assert.deepEqual(seen, ["Hello ", "there."]);
});
