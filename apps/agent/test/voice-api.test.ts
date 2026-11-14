import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { synthesize, VoiceError, resetVoiceState } from "../src/voice.ts";

// Mocked ElevenLabs: nothing leaves the machine and no credits are used.
const realFetch = globalThis.fetch;
type Call = { url: string; body: any; headers: any };
let calls: Call[] = [];
function mock(handler: (c: Call) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: any, init: any) => {
    const c = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
}
const audio = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });

function setup() {
  calls = [];
  resetVoiceState();
  config.elevenKey = "test-key";
  config.elevenVoice = "voice123";
  config.elevenModel = "eleven_v4_turbo";
  config.ttsDailyChars = 20000;
  config.elevenConcurrency = 2;
  config.ttsDiskCache = false; // tests must not touch the real cache
  resetVoiceState();
}
function teardown() {
  globalThis.fetch = realFetch;
  config.elevenKey = "";
  config.elevenVoice = "";
}

test("sends expressive settings, normalization and neighbouring text", async () => {
  setup(); mock(() => audio());
  try {
    const out = await synthesize("Rhea pays 11.69% on USDC, is that okay?", { previous: "What is the rate?", next: "Want me to compare?" });
    assert.equal(out.length, 4);
    const c = calls[0];
    assert.match(c.url, /\/v1\/text-to-speech\/voice123\?output_format=mp3_44100_64$/);
    assert.equal(c.headers["xi-api-key"], "test-key");
    assert.equal(c.body.model_id, "eleven_v4_turbo");
    assert.equal(c.body.apply_text_normalization, "on");
    assert.equal(c.body.voice_settings.stability, 0.4);
    assert.equal(c.body.previous_text, "What is the rate?");
    assert.equal(c.body.next_text, "Want me to compare?");
  } finally { teardown(); }
});

test("falls back to the fast model when the preferred one is rejected", async () => {
  setup();
  mock((c) => (c.body.model_id === "eleven_v4_turbo" ? new Response("{}", { status: 422 }) : audio()));
  try {
    await synthesize("Fallback test phrase.");
    assert.deepEqual(calls.map((c) => c.body.model_id), ["eleven_v4_turbo", "eleven_flash_v2_5"]);
  } finally { teardown(); }
});

test("identical text is served from cache without a second call", async () => {
  setup(); mock(() => audio());
  try {
    await synthesize("Cache me please.");
    await synthesize("Cache me please.");
    assert.equal(calls.length, 1);
  } finally { teardown(); }
});

test("a bad key maps to 401 and is not retried", async () => {
  setup(); mock(() => new Response("{}", { status: 401 }));
  try {
    await assert.rejects(() => synthesize("Bad key phrase."), (e: unknown) => e instanceof VoiceError && e.status === 401);
    assert.equal(calls.length, 1);
  } finally { teardown(); }
});

test("daily character budget stops spending", async () => {
  setup(); config.ttsDailyChars = 30; mock(() => audio());
  try {
    await synthesize("Short one here.");               // 15 chars
    await assert.rejects(() => synthesize("This second phrase is longer than the remaining budget."), (e: unknown) => e instanceof VoiceError && e.status === 429);
    assert.equal(calls.length, 1);
  } finally { teardown(); }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("never runs more requests in parallel than the plan allows (the 'too many concurrent requests' bug)", async () => {
  setup();
  let active = 0, peak = 0;
  mock(async () => {
    active++; peak = Math.max(peak, active);
    await sleep(30);
    active--;
    return audio();
  });
  try {
    const results = await Promise.all(["one aaa", "two bbb", "three ccc", "four ddd", "five eee", "six fff"].map((t) => synthesize(t)));
    assert.equal(results.length, 6);
    assert.ok(peak <= 2, `peak parallel requests was ${peak}`);
    assert.equal(calls.length, 6);
  } finally { teardown(); }
});

test("a 'busy' answer from ElevenLabs is retried, not surfaced as a failure", async () => {
  setup();
  let n = 0;
  mock(() => (n++ === 0
    ? new Response(JSON.stringify({ detail: { code: "concurrent_limit_exceeded" } }), { status: 429 })
    : audio()));
  try {
    const out = await synthesize("Retry me please.");
    assert.equal(out.length, 4);
    assert.equal(calls.length, 2);
  } finally { teardown(); }
});

test("running out of credits is reported clearly and not retried", async () => {
  setup();
  mock(() => new Response(JSON.stringify({ detail: { code: "quota_exceeded", message: "credits" } }), { status: 429 }));
  try {
    await assert.rejects(() => synthesize("No credits left."), (e: unknown) => e instanceof VoiceError && e.status === 402);
    assert.equal(calls.length, 1);
  } finally { teardown(); }
});

test("a real answer is served before background prefetching", async () => {
  setup(); config.elevenConcurrency = 1; resetVoiceState();
  const order: string[] = [];
  mock(async (c) => { order.push(c.body.text); await sleep(20); return audio(); });
  try {
    const running = synthesize("first running");              // takes the only slot
    await sleep(5);
    const low = synthesize("prefetch phrase", {}, { priority: 1 });
    const high = synthesize("real answer sentence", {}, { priority: 0 });
    await Promise.all([running, low, high]);
    assert.deepEqual(order, ["first running", "real answer sentence", "prefetch phrase"]);
  } finally { teardown(); config.elevenConcurrency = 2; }
});

test("the same phrase requested twice at once makes only one request", async () => {
  setup();
  mock(async () => { await sleep(20); return audio(); });
  try {
    await Promise.all([synthesize("Shared phrase here."), synthesize("Shared phrase here.")]);
    assert.equal(calls.length, 1);
  } finally { teardown(); }
});

test("a failed request does not use up the daily budget", async () => {
  setup(); config.ttsDailyChars = 40;
  mock(() => new Response("{}", { status: 500 }));
  try {
    await assert.rejects(() => synthesize("This will fail now."));
    mock(() => audio());
    await synthesize("This will work now.");                   // would exceed 40 if the failed 19 chars were still counted
  } finally { teardown(); }
});

test("a phrase already on disk is not requested (or paid for) again, even after a restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/orbi-tts-`);
  setup(); config.ttsDiskCache = true; config.ttsCacheDir = dir;
  mock(() => audio());
  try {
    await synthesize("You're welcome!");
    await sleep(60);                       // the disk write is not awaited by design
    resetVoiceState();                     // simulates a restart: memory cache gone
    config.ttsDiskCache = true;
    const again = await synthesize("You're welcome!");
    assert.equal(again.length, 4);
    assert.equal(calls.length, 1, "second request should come from disk");
    config.elevenVoice = "otherVoice";     // a different voice must not reuse the old audio
    await synthesize("You're welcome!");
    assert.equal(calls.length, 2);
  } finally { teardown(); rmSync(dir, { recursive: true, force: true }); config.ttsDiskCache = false; }
});
