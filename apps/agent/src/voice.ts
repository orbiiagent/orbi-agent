// Text-to-speech through ElevenLabs. Only the text Orbi is about to say leaves this machine.
// The API key stays on the server. Without a key, callers get a 501 and the browser voice is used.
//
// Plans limit how many requests may run in parallel (the free plan allows 2). Everything goes through a
// small priority queue so Orbi never exceeds that, answers are served before background prefetching,
// and a "too many concurrent requests" reply is retried instead of being shown as a failure.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";

export class VoiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const voiceEnabled = () => Boolean(config.elevenKey && config.elevenVoice);

// Plain text only: no markdown, bounded length.
export function prepare(text: string): string {
  return text
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

// ---- priority limiter: lower priority number runs first, FIFO within a priority ----
class Limiter {
  max: number;
  active = 0;
  seq = 0;
  waiting: { priority: number; seq: number; start: () => void }[] = [];
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(priority: number, fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push({ priority, seq: this.seq++, start: resolve }));
      // the slot was handed to us directly; `active` already counts it
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const next = this.waiting.shift();
      if (next) next.start();
      else this.active--;
    }
  }
}
const limiter = new Limiter(config.elevenConcurrency);
export const inFlightLimit = () => ({ active: limiter.active, waiting: limiter.waiting.length, max: limiter.max });

const cache = new Map<string, Buffer>();
const inflight = new Map<string, Promise<Buffer>>();
const CACHE_MAX = 120;
let budget = { day: new Date().toISOString().slice(0, 10), used: 0 };
export const stats = { ok: 0, failed: 0, retried: 0, fromDisk: 0, lastError: "" };

function charge(n: number) {
  const day = new Date().toISOString().slice(0, 10);
  if (budget.day !== day) budget = { day, used: 0 };
  if (budget.used + n > config.ttsDailyChars) throw new VoiceError(429, "Daily voice budget reached");
  budget.used += n;
}
const refund = (n: number) => {
  budget.used = Math.max(0, budget.used - n);
};

async function call(model: string, text: string, previous?: string, next?: string): Promise<Response> {
  const body: Record<string, unknown> = {
    text,
    model_id: model,
    voice_settings: {
      stability: config.voiceStability,
      similarity_boost: config.voiceSimilarity,
      style: config.voiceStyle,
      speed: config.voiceSpeed,
      use_speaker_boost: true,
    },
    // Reads numbers and symbols the way a person would say them ("11.69%").
    apply_text_normalization: "on",
  };
  if (previous) body.previous_text = prepare(previous).slice(-300);
  if (next) body.next_text = prepare(next).slice(0, 300);
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenVoice)}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": config.elevenKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- disk cache: the same words in the same voice settings are never paid for twice ----
const diskKey = (text: string) =>
  createHash("sha1")
    .update([config.elevenModel, config.elevenVoice, config.voiceStability, config.voiceSimilarity, config.voiceStyle, config.voiceSpeed, text].join("|"))
    .digest("hex");
const diskable = (text: string) => config.ttsDiskCache && text.length <= 200; // short phrases only; long one-off answers are not worth keeping
async function readDisk(text: string): Promise<Buffer | null> {
  if (!diskable(text)) return null;
  try {
    return await readFile(join(config.ttsCacheDir, `${diskKey(text)}.mp3`));
  } catch {
    return null;
  }
}
function writeDisk(text: string, audio: Buffer) {
  if (!diskable(text)) return;
  mkdir(config.ttsCacheDir, { recursive: true })
    .then(() => writeFile(join(config.ttsCacheDir, `${diskKey(text)}.mp3`), audio))
    .catch(() => {}); // a cache failure must never break speech
}
export const isCachedOnDisk = async (text: string) => (await readDisk(prepare(text))) !== null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One request with retries when ElevenLabs says it is busy.
async function request(model: string, text: string, previous?: string, next?: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await call(model, text, previous, next);
    if (res.status !== 429 || attempt >= 3) return res;
    const body = await res.clone().text();
    if (!/concurrent_limit_exceeded|too_many_concurrent|rate_limit/i.test(body)) return res; // e.g. out of credits: do not retry
    stats.retried++;
    await sleep(350 * (attempt + 1));
  }
}

async function produce(text: string, key: string, ctx: { previous?: string; next?: string }, priority: number): Promise<Buffer> {
  charge(text.length);
  try {
    const audio = await limiter.run(priority, async () => {
      let res = await request(config.elevenModel, text, ctx.previous, ctx.next);
      // If the preferred model is not available on this account, retry once with the fast model.
      if ([400, 404, 422].includes(res.status) && config.elevenModel !== config.elevenFallbackModel) {
        res = await request(config.elevenFallbackModel, text, ctx.previous, ctx.next);
      }
      if (res.status === 401 || res.status === 403) throw new VoiceError(401, "ElevenLabs rejected the API key");
      if (res.status === 429) {
        const body = await res.text();
        throw new VoiceError(/quota|credit/i.test(body) ? 402 : 429, /quota|credit/i.test(body) ? "ElevenLabs credits used up" : "ElevenLabs is busy");
      }
      if (!res.ok) throw new VoiceError(502, `ElevenLabs error ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, audio);
    writeDisk(text, audio);
    stats.ok++;
    return audio;
  } catch (e) {
    refund(text.length); // a failed request should not use up our own budget counter
    stats.failed++;
    stats.lastError = (e as Error).message;
    throw e;
  }
}

// priority 0 = something Orbi is about to say; 1 = background prefetch of short phrases
export async function synthesize(
  rawText: string,
  ctx: { previous?: string; next?: string } = {},
  opts: { priority?: number } = {}
): Promise<Buffer> {
  if (!voiceEnabled()) throw new VoiceError(501, "Voice is not configured");
  const text = prepare(rawText);
  if (!text) throw new VoiceError(400, "Nothing to say");
  const key = `${config.elevenModel}|${config.elevenVoice}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const onDisk = await readDisk(text);
  if (onDisk) {
    cache.set(key, onDisk);
    stats.fromDisk++;
    return onDisk;
  }
  const pending = inflight.get(key); // the same phrase requested twice at once shares one request
  if (pending) return pending;
  const p = produce(text, key, ctx, opts.priority ?? 0).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// For tests: start from an empty cache and a fresh daily budget.
export function resetVoiceState() {
  cache.clear();
  inflight.clear();
  budget = { day: new Date().toISOString().slice(0, 10), used: 0 };
  stats.ok = stats.failed = stats.retried = stats.fromDisk = 0;
  stats.lastError = "";
  limiter.max = config.elevenConcurrency;
}

export const voiceBudget = () => ({ used: budget.used, limit: config.ttsDailyChars });
