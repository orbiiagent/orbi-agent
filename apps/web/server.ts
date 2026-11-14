// Orbi web server: serves the UI, runs the agent per session, proxies speech-to-text.
// Binds to localhost only. The API key never reaches the browser.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { config } from "../agent/src/config.ts";
import { Orbi } from "../agent/src/agent.ts";
import { warmResearchCache, researchReady } from "../agent/src/research.ts";
import { synthesize, voiceEnabled, VoiceError, stats, inFlightLimit } from "../agent/src/voice.ts";
import { fixSpeech } from "../agent/src/speechfix.ts";
import { approve, reject, openCard, ApprovalError } from "../agent/src/actions.ts";
import { policyState } from "../agent/src/tools.ts";
import { getRun } from "../agent/src/progress.ts";
import { openDeposit, depositStatus, getRefundAddress, setRefundAddress, BridgeError } from "../agent/src/bridge.ts";
import { listNotes, forgetNote, clearNotes, memoryEnabled } from "../agent/src/memory.ts";
import { computeHabits } from "../agent/src/habits.ts";
import { addContact, listContacts, removeContact, seedDefaultContacts, checkNewContact } from "../agent/src/contacts.ts";
import { accountExistsOnChain } from "../agent/src/chain.ts";
import { multiUser, bindSession, bindSessionIp, unbindSession, sessionBelongsTo, ownerFromCookie, ownerCookie, OwnerError } from "../agent/src/owner.ts";
import { aiState, aiNotice, pingAi, markAi, toAiError, kindFromStatus } from "../agent/src/aiErrors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// Locally it listens on this computer only. On Railway it must listen on all interfaces to be reachable.
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1");
// A hosted copy shares one demo wallet between strangers, so it must never move real funds unless that is forced on.
if (multiUser() && config.executionMode === "live" && process.env.ORBI_ALLOW_PUBLIC_LIVE !== "1") {
  (config as { executionMode: string }).executionMode = "rehearsal";
  console.warn("ORBI_MULTIUSER is on, so live mode was switched to rehearsal (nothing will be signed). Set ORBI_ALLOW_PUBLIC_LIVE=1 only if you really mean it.");
}
if (!config.nearAiKey) {
  console.error("NEAR_AI_API_KEY is missing from .env");
  process.exit(1);
}

// ---- sessions and a simple per-client rate limit ----
const sessions = new Map<string, { orbi: Orbi; last: number }>();
const hits = new Map<string, number[]>();
const MAX_TURNS_PER_HOUR = Number(process.env.ORBI_MAX_TURNS_PER_HOUR || 60);

// Speech clips have their own, larger limit: one spoken answer is several clips, and a shared limit
// made /api/speak start refusing after a few conversations (the page then fell back to the browser voice).
const speakHits = new Map<string, number[]>();
const MAX_SPEAK_PER_HOUR = Number(process.env.ORBI_MAX_SPEAK_PER_HOUR || 600);

function limited(map: Map<string, number[]>, ip: string, max: number): boolean {
  const now = Date.now();
  const recent = (map.get(ip) ?? []).filter((t) => now - t < 3600_000);
  recent.push(now);
  map.set(ip, recent);
  return recent.length > max;
}
const rateLimited = (ip: string) => limited(hits, ip, MAX_TURNS_PER_HOUR);
const speakLimited = (ip: string) => limited(speakHits, ip, MAX_SPEAK_PER_HOUR);
function getSession(id: string, owner?: string, ip?: string) {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.last > 30 * 60_000) { sessions.delete(k); unbindSession(k); }
  let s = sessions.get(id);
  if (s && !sessionBelongsTo(id, owner)) throw new OwnerError("That session belongs to someone else."); // a session id is useless without its own cookie
  if (!s) {
    if (sessions.size >= 50) throw new Error("Too many active sessions");
    bindSession(id, owner);
    s = { orbi: new Orbi(id), last: now };
    sessions.set(id, s);
  }
  bindSessionIp(id, ip); // the latest address this session came from, for the per-connection cap
  s.last = now;
  return s;
}

async function readBody(req: import("node:http").IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

// The approve endpoint can move money, so no other website may reach it through the visitor's browser:
//  - Host must be this server's own name (blocks DNS-rebinding),
//  - a browser POST/DELETE must come from this same origin, and never from another site (blocks cross-site requests),
//  - and approving also needs the unguessable session id and card hash that only this page has.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const extraHosts = (process.env.ORBI_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return LOOPBACK.has(name) || extraHosts.includes(h) || extraHosts.includes(name);
}
function sameOrigin(req: import("node:http").IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (!origin) return true; // not a browser request (curl, tests): the session id and hash still protect it
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host)) return json(res, 403, { error: "Unexpected host" });
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json(res, 403, { error: "Cross-site request refused" });
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    // Behind a proxy every request comes from the proxy, so the rate limit needs the real client address (opt in).
    const ip = (process.env.ORBI_TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || (req.socket.remoteAddress ?? "unknown");
    // Hosted copy: each browser gets a private random id in a cookie. Everything personal is kept under that id.
    let owner = multiUser() ? ownerFromCookie(req.headers.cookie) : undefined;
    if (multiUser() && !owner) {
      owner = randomBytes(16).toString("hex");
      res.setHeader("Set-Cookie", ownerCookie(owner, process.env.ORBI_COOKIE_SECURE === "1" || req.headers["x-forwarded-proto"] === "https"));
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(readFileSync(join(here, "public", "index.html")));
    }
    // On-device wake word engine files (vendored, no network): only files that sit directly inside public/wake.
    if ((req.method === "GET" || req.method === "HEAD") && /^\/wake\/(models\/)?[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(url.pathname)) {
      const file = join(here, "public", url.pathname);
      if (!existsSync(file)) return json(res, 404, { error: "Not found" });
      const types: Record<string, string> = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream" };
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      return res.end(req.method === "HEAD" ? undefined : readFileSync(file));
    }
    // QR code generator (qrcode-generator 1.4.4, MIT), vendored so the page needs no outside script.
    if (req.method === "GET" && url.pathname === "/vendor/qrcode.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
      return res.end(readFileSync(join(here, "public", "vendor", "qrcode.js")));
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        name: "Orbi",
        ai: { ok: aiState.ok, kind: aiState.kind, notice: aiNotice() },
        model: config.model,
        account: config.agentAccount,
        mode: config.executionMode === "live" ? `live on ${config.network}` : config.executionMode === "rehearsal" ? "rehearsal (nothing is sent)" : "read-only",
        execution: config.executionMode,
        network: config.network,
        hosted: multiUser(), // a shared demo: small limits, one contact, no deposits
        live_actions_per_day: config.maxLiveActionsPerDay || null,
        live_actions_per_visitor: config.maxLiveActionsPerVisitor || null,
        live_sends_per_day: config.maxLiveSendsPerDay || null,
        limits: { per_action_usd: config.maxActionUsd, per_day_usd: config.maxDailyUsd, first_payment_usd: config.maxNewAddressUsd },
        orbi_fee_percent: config.feeRecipient ? config.feePerMille / 10 : 0,
        ready: researchReady(), // rate and price data loaded
        voice: voiceEnabled() ? "elevenlabs" : "browser",
        voice_stats: voiceEnabled() ? { ...stats, ...inFlightLimit() } : undefined,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/contacts") return json(res, 200, { contacts: listContacts(owner) });
    if (req.method === "POST" && url.pathname === "/api/contacts") {
      const { name, address } = JSON.parse((await readBody(req, 5_000)).toString("utf8"));
      if (multiUser()) return json(res, 403, { error: "Adding contacts is switched off on this shared demo." });
      try {
        const check = await checkNewContact(String(address ?? ""), accountExistsOnChain);
        if (!check.ok) return json(res, 400, { error: check.error });
        return json(res, 200, { contact: addContact(String(name ?? ""), String(address ?? ""), owner), notice: check.notice });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (req.method === "DELETE" && url.pathname === "/api/contacts") {
      return removeContact(String(url.searchParams.get("name") ?? ""), owner) ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such contact" });
    }
    if (req.method === "GET" && url.pathname === "/api/memory") return json(res, 200, { enabled: memoryEnabled(), notes: listNotes(owner), habits: memoryEnabled() && process.env.ORBI_HABITS !== "off" ? computeHabits(undefined, owner) : [] });
    if (req.method === "DELETE" && url.pathname === "/api/memory") {
      if (url.searchParams.get("all") === "1") return json(res, 200, { ok: true, removed: clearNotes(owner) });
      const { removed } = forgetNote(String(url.searchParams.get("id") ?? ""), owner);
      return removed.length ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such note" });
    }
    if (req.method === "GET" && url.pathname === "/api/card") {
      const sid = String(url.searchParams.get("session") ?? "");
      if (!sessionBelongsTo(sid, owner)) return json(res, 200, { card: null });
      return json(res, 200, { card: openCard(sid) ?? openDeposit(sid) });
    }
    if (req.method === "GET" && url.pathname === "/api/progress") {
      const sid = String(url.searchParams.get("session") ?? "");
      if (!sessionBelongsTo(sid, owner)) return json(res, 403, { error: "Not your session" });
      return json(res, 200, getRun(sid, String(url.searchParams.get("id") ?? "")) ?? { status: "none", steps: [] });
    }
    if (req.method === "GET" && url.pathname === "/api/deposit-status") {
      try {
        if (!sessionBelongsTo(String(url.searchParams.get("session") ?? ""), owner)) return json(res, 403, { error: "Not your session" });
        return json(res, 200, await depositStatus(String(url.searchParams.get("session") ?? ""), String(url.searchParams.get("id") ?? "") || undefined));
      } catch (e) {
        return json(res, e instanceof BridgeError ? 400 : 500, { error: e instanceof BridgeError ? e.message : "Couldn't check the deposit right now." });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/bridge-settings") return json(res, 200, { refund: getRefundAddress(owner) });
    if (req.method === "POST" && url.pathname === "/api/bridge-settings") {
      const { refund } = JSON.parse((await readBody(req, 2_000)).toString("utf8"));
      try {
        return json(res, 200, { refund: setRefundAddress(String(refund ?? ""), owner) });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/approve") {
      const { session, id, hash } = JSON.parse((await readBody(req, 5_000)).toString("utf8"));
      if (!sessionBelongsTo(String(session ?? ""), owner)) return json(res, 403, { error: "Not your session" });
      try {
        return json(res, 200, await approve(String(session ?? ""), String(id ?? ""), String(hash ?? ""), policyState));
      } catch (e) {
        return json(res, e instanceof ApprovalError ? 400 : 500, { error: e instanceof ApprovalError ? e.message : "Something went wrong. Nothing was sent." });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/reject") {
      const { session, id } = JSON.parse((await readBody(req, 5_000)).toString("utf8"));
      if (!sessionBelongsTo(String(session ?? ""), owner)) return json(res, 403, { error: "Not your session" });
      return json(res, 200, { ok: reject(String(session ?? ""), String(id ?? "")) });
    }
    if (req.method === "POST" && url.pathname === "/api/speak") {
      if (!voiceEnabled()) return json(res, 501, { error: "Voice is not configured" });
      if (speakLimited(ip)) return json(res, 429, { error: "Voice rate limit reached. Try again later." });
      const { text, previous, next, low } = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "Bad text" });
      try {
        const audio = await synthesize(
          text,
          { previous: typeof previous === "string" ? previous : undefined, next: typeof next === "string" ? next : undefined },
          { priority: low ? 1 : 0 } // low = background prefetch, served after real answers
        );
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
        return res.end(audio);
      } catch (e) {
        const status = e instanceof VoiceError ? e.status : 502;
        console.warn(`voice failed (${status}): ${(e as Error).message}`);
        return json(res, status, { error: (e as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (rateLimited(ip)) return json(res, 429, { error: "Rate limit reached. Try again later." });
      const { session, text } = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      if (typeof text !== "string" || !text.trim() || text.length > 500) return json(res, 400, { error: "Bad message" });
      const s = getSession(String(session || randomUUID()), owner, ip);
      const tools: unknown[] = [];
      const t0 = performance.now();
      const reply = await s.orbi.say(text.trim(), (e) => tools.push(e));
      return json(res, 200, { reply, tools, ms: Math.round(performance.now() - t0) });
    }
    if (req.method === "POST" && url.pathname === "/api/chat-stream") {
      if (rateLimited(ip)) return json(res, 429, { error: "Rate limit reached. Try again later." });
      const { session, text } = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      if (typeof text !== "string" || !text.trim() || text.length > 500) return json(res, 400, { error: "Bad message" });
      const s = getSession(String(session || randomUUID()), owner, ip);
      // Newline-delimited JSON: tool_start, tool, sentence, done (or error). Sentences arrive while the model is still writing.
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const send = (o: unknown) => res.write(JSON.stringify(o) + "\n");
      const t0 = performance.now();
      try {
        const reply = await s.orbi.say(text.trim(), undefined, {
          onToolStart: (name) => send({ type: "tool_start", name }),
          onTool: (e) => send({ type: "tool", ...e }),
          onSentence: (sentence) => send({ type: "sentence", text: sentence }),
          onAction: (card) => send({ type: "action", card }),
        });
        send({ type: "done", reply, path: s.orbi.lastPath, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        console.error("stream error:", (e as Error).message);
        send({ type: "error", message: "Something went wrong. Please try again." });
      }
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      if (rateLimited(ip)) return json(res, 429, { error: "Rate limit reached. Try again later." });
      const audio = await readBody(req, 5_000_000);
      if (audio.length < 1000) return json(res, 400, { error: "Audio too short" });
      const fd = new FormData();
      fd.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
      fd.append("model", "openai/whisper-large-v3");
      fd.append("language", "en");
      fd.append("prompt", "Orbi, Rhea, NEAR, USDC, USDT, APY, lending rate, swap, wNEAR, Intents, DeFi.");
      const t0 = performance.now();
      // The transcription runs on the same AI service as the answers: say so plainly if it is the one having trouble.
      const trouble = "The transcription service is having trouble, and that's the service, not Orbi. You can type your question, or turn on fast listening in Settings.";
      let r: Response;
      try {
        r = await fetch(`${config.nearAiBase}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.nearAiKey}` },
          body: fd,
          signal: AbortSignal.timeout(25_000),
        });
      } catch (e) {
        markAi(false, toAiError(e).kind);
        return json(res, 502, { error: trouble });
      }
      const body: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        markAi(false, kindFromStatus(r.status));
        return json(res, 502, { error: r.status === 429 ? "The transcription service is busy right now. Give it a moment, or type your question." : trouble });
      }
      return json(res, 200, { text: fixSpeech(body.text ?? ""), ms: Math.round(performance.now() - t0) });
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof OwnerError) return json(res, 403, { error: e.message });
    console.error("request error:", (e as Error).message);
    json(res, 500, { error: "Something went wrong. Please try again." });
  }
});

warmResearchCache();
seedDefaultContacts();
// Keep an eye on the AI service in the background, so the page can say so before anyone asks a question.
pingAi(config.nearAiBase, config.nearAiKey);
setInterval(() => pingAi(config.nearAiBase, config.nearAiKey), 60_000).unref();
server.listen(PORT, HOST, () => {
  console.log(`Orbi running at http://${HOST}:${PORT}`);
  if (config.executionMode === "live") console.log(`!! LIVE MODE on ${config.network}: approved swaps and sends WILL move real funds from ${config.agentAccount}. Limits: $${config.maxActionUsd} per action, $${config.maxDailyUsd} per day.`);
  else if (config.executionMode === "rehearsal") console.log("Rehearsal mode: the full flow runs but nothing is ever signed or sent. Set ORBI_EXECUTION=live to enable real transactions.");
  else console.log("Execution is off: Orbi can only look things up.");
});
