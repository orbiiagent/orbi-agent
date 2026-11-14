// All configuration comes from environment variables (loaded with `node --env-file=.env`).
import { fileURLToPath } from "node:url";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export const config = {
  nearAiKey: process.env.NEAR_AI_API_KEY ?? "",
  nearAiBase: "https://cloud-api.near.ai/v1",
  model: process.env.NEAR_AI_MODEL || "anthropic/claude-haiku-5-5",
  agentAccount: process.env.NEAR_AGENT_ACCOUNT_ID ?? "",
  intentsJwt: process.env.INTENTS_JWT || "",
  intentsApi: "https://1click.chaindefuser.com",
  rheaRouter: "https://smartx.rhea.finance/swapMultiDexPath",
  // FastNEAR measured ~0.3 s vs ~3.3 s for the default public RPC, so it goes first.
  rpcUrls: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
  feeRecipient: process.env.ORBI_FEE_RECIPIENT || "",
  feePerMille: num("ORBI_FEE_PER_MILLE", 1), // 1 = 0.1%
  maxActionUsd: num("ORBI_MAX_ACTION_USD", 10),
  maxDailyUsd: num("ORBI_MAX_DAILY_USD", 25),
  maxLiveActionsPerVisitor: num("ORBI_MAX_LIVE_ACTIONS_PER_VISITOR", 0), // per browser per day, on a shared demo (0 = no per-person cap)
  maxLiveActionsPerIp: num("ORBI_MAX_LIVE_ACTIONS_PER_IP", 0), // per network address per day, on a shared demo (0 = off)
  maxLiveSendsPerDay: num("ORBI_MAX_LIVE_SENDS_PER_DAY", 0), // sends to the demo contact, all visitors together (0 = off)
  maxLiveSendUsdPerDay: num("ORBI_MAX_LIVE_SEND_USD_PER_DAY", 0),
  maxLiveActionsPerDay: num("ORBI_MAX_LIVE_ACTIONS_PER_DAY", 0), // 0 = no cap on the number of real actions per day (set it on a shared demo)
  slippage: 0.005,
  // Bringing USDC in from Base through NEAR Intents. Orbi signs nothing for this; the owner sends the funds themselves.
  maxBridgeUsd: num("ORBI_MAX_BRIDGE_USD", 100), // most USDC one deposit card may ask for
  bridgeDeadlineMin: num("ORBI_BRIDGE_DEADLINE_MIN", 60), // how long the deposit address stays valid
  // Execution. "off" refuses to propose actions; "rehearsal" runs the whole flow with a clearly labelled SIMULATED result
  // and never signs; "live" really signs and sends. Live is never the default.
  executionMode: (["off", "rehearsal", "live"].includes(process.env.ORBI_EXECUTION ?? "") ? process.env.ORBI_EXECUTION : "rehearsal") as "off" | "rehearsal" | "live",
  network: (process.env.ORBI_NETWORK === "testnet" ? "testnet" : "mainnet") as "mainnet" | "testnet",
  agentKey: process.env.NEAR_AGENT_PRIVATE_KEY ?? "",
  maxNewAddressUsd: num("ORBI_MAX_NEW_ADDRESS_USD", 5), // lower cap for an address that has never been paid before
  minNativeReserveNear: num("ORBI_MIN_RESERVE_NEAR", 0.2), // always keep this much NEAR for fees and storage
  maxDriftPct: num("ORBI_MAX_DRIFT_PCT", 1), // a swap is cancelled if the fresh quote is worse than the approved one by more than this
  pendingTtlSec: num("ORBI_PENDING_TTL_SEC", 120), // an approval card expires after this long
  // Fast path: code answers clear read-only requests without model round trips. Set ORBI_FASTPATH=off to compare.
  fastPath: process.env.ORBI_FASTPATH !== "off",
  // Voice (ElevenLabs). Optional: without a key the browser voice is used.
  elevenKey: process.env.ELEVENLABS_API_KEY || "",
  elevenVoice: process.env.ELEVENLABS_VOICE_ID || "",
  elevenModel: process.env.ELEVENLABS_MODEL || "eleven_v4_turbo",
  elevenFallbackModel: "eleven_flash_v2_5",
  voiceStability: num("ELEVENLABS_STABILITY", 0.4), // lower = more expressive
  voiceSimilarity: num("ELEVENLABS_SIMILARITY", 0.75),
  voiceStyle: num("ELEVENLABS_STYLE", 0.35),
  voiceSpeed: num("ELEVENLABS_SPEED", 1.0),
  ttsDailyChars: num("ORBI_TTS_DAILY_CHARS", 20000), // spending guard
  // Generated voice clips are kept on disk (git-ignored), so a phrase only costs credits the first time it is ever spoken.
  ttsDiskCache: process.env.ORBI_TTS_DISK_CACHE !== "off",
  ttsCacheDir: process.env.ORBI_TTS_CACHE_DIR || fileURLToPath(new URL("../../../.cache/tts", import.meta.url)),
  // ElevenLabs limits parallel requests per plan (free plan: 2). We queue to stay under it.
  elevenConcurrency: Math.max(1, Math.floor(num("ELEVENLABS_CONCURRENCY", 2))),
};

if (config.feePerMille < 0 || config.feePerMille > 1000) {
  throw new Error("ORBI_FEE_PER_MILLE must be between 0 and 1000");
}
