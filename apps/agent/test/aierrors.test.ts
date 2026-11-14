import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = mkdtempSync(`${tmpdir()}/orbi-ai-`);
process.env.ORBI_CONTACTS_FILE = `${dir}/contacts.json`;
process.env.ORBI_ACTIVITY_FILE = `${dir}/activity.jsonl`;
process.env.NEAR_AI_API_KEY = "test-key";
process.env.NEAR_AGENT_ACCOUNT_ID = "a".repeat(64);

const { Orbi } = await import("../src/agent.ts");
const { aiProblemMessage, aiTuning, aiState, kindFromStatus, toAiError, AiServiceError, aiNotice, markAi } = await import("../src/aiErrors.ts");
const { streamTuning } = await import("../src/stream.ts");

aiTuning.retryMs = 0;
aiTuning.busyRetryMs = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = realFetch;
  streamTuning.firstByteMs = 20_000;
  aiTuning.firstByteMs = 12_000;
  aiTuning.quickFirstByteMs = 6_000;
  markAi(true);
});

const ok = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
const fail = (status: number) => new Response(JSON.stringify({ error: { message: "Failed to validate API key" } }), { status });
const QUESTION = "what should I do about my taxes"; // not a quick lookup, so it needs the model

test("statuses and errors are classified", () => {
  assert.equal(kindFromStatus(500), "down");
  assert.equal(kindFromStatus(502), "down");
  assert.equal(kindFromStatus(429), "busy");
  for (const s of [401, 402, 403]) assert.equal(kindFromStatus(s), "auth");
  assert.equal(kindFromStatus(504), "timeout");
  assert.equal(toAiError(new TypeError("fetch failed")).kind, "network");
  assert.equal(toAiError(Object.assign(new Error("x"), { name: "AbortError" })).kind, "timeout");
  const e = new AiServiceError("busy", "x");
  assert.equal(toAiError(e), e);
});

test("a service outage becomes a plain, spoken explanation that blames the service and names what still works", async () => {
  globalThis.fetch = (async () => fail(500)) as typeof fetch;
  const o = new Orbi("t1");
  const spoken: string[] = [];
  const before = o.history.length;
  const reply = await o.say(QUESTION, undefined, { onSentence: (s) => spoken.push(s) });
  assert.match(reply, /not me|on them|not on me/i);
  assert.match(reply, /balances/i);
  assert.match(reply, /last transaction/i);
  assert.ok(spoken.length >= 1, "it is spoken through the normal sentence events");
  assert.equal(o.history.length, before, "the failed turn is rolled back so later questions are not poisoned");
  assert.equal(o.lastPath, "fast");
  assert.equal(aiState.ok, false);
  assert.match(aiNotice(), /having trouble/);
});

test("one automatic retry rescues a hiccup, and the answer is normal", async () => {
  let calls = 0;
  globalThis.fetch = (async () => (++calls === 1 ? fail(500) : ok("Hmm, that depends on where you live."))) as typeof fetch;
  const reply = await new Orbi("t2").say(QUESTION);
  assert.equal(calls, 2);
  assert.equal(reply, "Hmm, that depends on where you live.");
  assert.equal(aiState.ok, true);
});

test("a rejected key is not retried and says it is an account problem for the owner", async () => {
  let calls = 0;
  globalThis.fetch = (async () => (++calls, fail(401))) as typeof fetch;
  const reply = await new Orbi("t3").say(QUESTION);
  assert.equal(calls, 1);
  assert.match(reply, /account problem|API key|credit/i);
  assert.match(aiNotice(), /rejecting/);
});

test("a service that never answers times out and says so", async () => {
  aiTuning.firstByteMs = 30;
  globalThis.fetch = ((_u: any, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
  const reply = await new Orbi("t4").say(QUESTION);
  assert.match(reply, /took too long|isn't answering/i);
});

test("a dropped connection is explained as a connection problem", async () => {
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const reply = await new Orbi("t5").say(QUESTION);
  assert.match(reply, /can't reach|can't get through/i);
});

test("if a card was already shown, the message points at it", () => {
  assert.match(aiProblemMessage("down", { cardShown: true }), /card is ready.*tap Approve/i);
  assert.doesNotMatch(aiProblemMessage("down", {}), /card is ready/i);
});

test("quick lookups still work with the AI service down, and a real bug is not disguised as an outage", async () => {
  globalThis.fetch = (async () => fail(500)) as typeof fetch;
  const o = new Orbi("t6");
  const r = await o.say("what was my last transaction?"); // answered in code, no model call needed
  assert.match(r, /haven't sent|Your last one/);
  const { toAiError: t } = await import("../src/aiErrors.ts");
  assert.ok(!(new Error("a bug") instanceof AiServiceError));
  assert.equal(t(new Error("a bug")).kind, "network"); // only errors from the service call are converted, and agent.ts rethrows anything else
});

test("when the service was just seen down, Orbi fails fast: a short wait and no retry", async () => {
  markAi(false, "down");
  aiTuning.quickFirstByteMs = 30;
  let calls = 0;
  globalThis.fetch = ((_u: any, init: any) => { calls++; return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); }) as typeof fetch;
  const t0 = Date.now();
  const reply = await new Orbi("t7").say(QUESTION);
  assert.equal(calls, 1, "no retry when the service is known to be down");
  assert.ok(Date.now() - t0 < 1000);
  assert.match(reply, /took too long|isn't answering/i);
});

test("a slow failure is not retried either (the service is struggling)", async () => {
  let calls = 0;
  aiTuning.retryOnlyIfFasterThanMs = 10;
  globalThis.fetch = (async () => { calls++; await new Promise((r) => setTimeout(r, 40)); return fail(500); }) as typeof fetch;
  await new Orbi("t8").say(QUESTION);
  aiTuning.retryOnlyIfFasterThanMs = 3000;
  assert.equal(calls, 1);
});
