// Read-only research: NEAR yields (DefiLlama) and token prices (NEAR Intents token list).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";

type Pool = {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  stablecoin: boolean;
};

let poolsCache: { at: number; pools: Pool[] } | null = null;
let poolsRefreshing: Promise<{ pools: Pool[]; fetchedAt: number }> | null = null;
const POOLS_FRESH_MS = 10 * 60 * 1000; // serve as-is
const POOLS_STALE_OK_MS = 30 * 60 * 1000; // serve instantly while refreshing in the background

async function fetchPools(): Promise<{ pools: Pool[]; fetchedAt: number }> {
  const res = await fetch("https://yields.llama.fi/pools");
  if (!res.ok) throw new Error(`DefiLlama yields failed (${res.status})`);
  const body: any = await res.json();
  const pools: Pool[] = (body.data as Pool[]).filter((p) => p.chain === "Near");
  poolsCache = { at: Date.now(), pools };
  saveToDisk();
  return { pools, fetchedAt: poolsCache.at };
}
function refreshPools() {
  poolsRefreshing ??= fetchPools().finally(() => {
    poolsRefreshing = null;
  });
  return poolsRefreshing;
}
async function loadPools(): Promise<{ pools: Pool[]; fetchedAt: number }> {
  const age = poolsCache ? Date.now() - poolsCache.at : Infinity;
  if (poolsCache && age < POOLS_FRESH_MS) return { pools: poolsCache.pools, fetchedAt: poolsCache.at };
  if (poolsCache && age < POOLS_STALE_OK_MS) {
    refreshPools().catch(() => {}); // stale-while-revalidate: answer now, update behind the scenes
    return { pools: poolsCache.pools, fetchedAt: poolsCache.at };
  }
  return refreshPools();
}

// Ready as soon as prices are known (the most common questions). Yields load on their own and are waited for only if asked.
export const researchReady = () => tokensCache !== null;

// ---- disk copy: the last data is reloaded at startup so Orbi can answer at once, then refreshed behind the scenes ----
const DISK = () => process.env.ORBI_RESEARCH_CACHE || join(process.cwd(), ".cache", "research.json");
let saveTimer: NodeJS.Timeout | null = null;
function saveToDisk() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(DISK()), { recursive: true });
      const tmp = `${DISK()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pools: poolsCache, tokens: tokensCache }));
      renameSync(tmp, DISK()); // whole file or nothing, never a half-written copy
    } catch {
      /* a missing disk copy only costs a slower first start */
    }
  }, 500);
  saveTimer.unref();
}
export function loadResearchFromDisk(): boolean {
  try {
    const d = JSON.parse(readFileSync(DISK(), "utf8"));
    const okAt = (x: any) => x && typeof x.at === "number" && x.at <= Date.now() + 60_000;
    if (okAt(d.pools) && Array.isArray(d.pools.pools)) poolsCache ??= d.pools;
    if (okAt(d.tokens) && Array.isArray(d.tokens.tokens)) tokensCache ??= d.tokens;
    return tokensCache !== null;
  } catch {
    return false; // no copy, or an unreadable one: just start from nothing
  }
}

// Try again quickly if a download fails, instead of waiting for the next scheduled refresh.
function refreshWithRetry(refresh: () => Promise<unknown>, delayMs = 3000, tries = 5) {
  refresh().catch(() => {
    if (tries > 1) setTimeout(() => refreshWithRetry(refresh, Math.min(delayMs * 2, 30_000), tries - 1), delayMs).unref();
  });
}

// Load the disk copy, then refresh both datasets in the background, so a question rarely waits for a download.
export function warmResearchCache() {
  loadResearchFromDisk();
  refreshWithRetry(refreshPools);
  refreshWithRetry(refreshTokens);
  setInterval(() => refreshTokens().catch(() => {}), 45_000).unref();
  setInterval(() => refreshPools().catch(() => {}), 5 * 60_000).unref();
}

export type YieldQuery = {
  symbol?: string;
  kind?: "lending" | "dex" | "staking" | "any";
  stablecoin_only?: boolean;
  min_apy?: number;
  max_apy?: number;
  limit?: number;
};

const kindOf = (project: string) =>
  project.includes("lend") ? "lending" : project.includes("dex") ? "dex" : project.includes("lst") ? "staking" : "other";

export async function getYields(q: YieldQuery) {
  const { pools, fetchedAt } = await loadPools();
  let list = pools.filter((p) => p.apy !== null && p.tvlUsd > 0);
  if (q.kind && q.kind !== "any") list = list.filter((p) => kindOf(p.project) === q.kind);
  if (q.symbol) {
    const s = q.symbol.trim().toUpperCase();
    list = list.filter((p) => p.symbol.toUpperCase().split("-").includes(s) || p.symbol.toUpperCase() === s);
  }
  if (q.stablecoin_only) list = list.filter((p) => p.stablecoin);
  if (q.min_apy !== undefined) list = list.filter((p) => (p.apy as number) >= q.min_apy!);
  if (q.max_apy !== undefined) list = list.filter((p) => (p.apy as number) <= q.max_apy!);
  list.sort((a, b) => b.tvlUsd - a.tvlUsd);
  const results = list.slice(0, q.limit ?? 5).map((p) => ({
    protocol: p.project,
    kind: kindOf(p.project),
    asset: p.symbol,
    apy_percent: Number((p.apy as number).toFixed(2)),
    apy_30d_average_percent: p.apyMean30d == null ? null : Number(p.apyMean30d.toFixed(2)),
    has_token_rewards: Boolean(p.apyReward),
    tvl_usd: Math.round(p.tvlUsd),
    // Code decides this flag, not the model: very small pools can show eye-catching APYs that are not dependable.
    liquidity: p.tvlUsd < 100_000 ? "thin (under $100k)" : p.tvlUsd < 1_000_000 ? "moderate" : "deep",
  }));
  return {
    source: "DefiLlama yields",
    data_age_minutes: Math.round((Date.now() - fetchedAt) / 60000),
    note: "Variable rates for supplying assets, not guaranteed. Only protocols DefiLlama tracks on NEAR are listed.",
    count: results.length,
    results,
  };
}

// ---- prices ----
let tokensCache: { at: number; tokens: any[] } | null = null;
let tokensRefreshing: Promise<any[]> | null = null;
const PRICES_FRESH_MS = 60_000; // serve as-is
const PRICES_STALE_OK_MS = 180_000; // up to 3 minutes old: serve now, refresh behind the scenes, and say how old it is

async function fetchTokens(): Promise<any[]> {
  const res = await fetch(`${config.intentsApi}/v0/tokens`);
  if (!res.ok) throw new Error(`Intents token list failed (${res.status})`);
  const tokens = (await res.json()) as any[];
  tokensCache = { at: Date.now(), tokens };
  saveToDisk();
  return tokens;
}
function refreshTokens() {
  tokensRefreshing ??= fetchTokens().finally(() => {
    tokensRefreshing = null;
  });
  return tokensRefreshing;
}
async function loadTokens(): Promise<any[]> {
  const age = tokensCache ? Date.now() - tokensCache.at : Infinity;
  if (tokensCache && age < PRICES_FRESH_MS) return tokensCache.tokens;
  if (tokensCache && age < PRICES_STALE_OK_MS) {
    refreshTokens().catch(() => {});
    return tokensCache.tokens;
  }
  return refreshTokens();
}

export async function getPrices(symbols: string[]) {
  const tokens = await loadTokens();
  return {
    source: "NEAR Intents token list",
    age_seconds: tokensCache ? Math.round((Date.now() - tokensCache.at) / 1000) : 0, // never present old data as live
    prices: symbols.map((raw) => {
      const sym = raw.trim().toUpperCase() === "NEAR" ? "WNEAR" : raw.trim().toUpperCase();
      const matches = tokens.filter((t) => t.symbol?.toUpperCase() === sym);
      const t = matches.find((m) => m.blockchain === "near") ?? matches[0];
      return t
        ? { symbol: raw.toUpperCase(), usd: Number(t.price), chain: t.blockchain, updated: t.priceUpdatedAt }
        : { symbol: raw.toUpperCase(), error: "not found" };
    }),
  };
}
