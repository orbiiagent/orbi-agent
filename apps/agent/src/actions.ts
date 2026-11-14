// Pending actions. The model can only PROPOSE: a proposal becomes an approval card and nothing else.
// Execution happens only through `approve`, which needs the session that created the card, the id, and the hash of
// exactly what the owner was shown. A card is single-use, expires, and every rule is checked again at approval time.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { checkAction, recordSpend, type PolicyState } from "./policy.ts";
import { findToken, fromUnits, toUnits } from "./tokens.ts";
import { resolveContact, recordSend } from "./contacts.ts";
import { multiUser, ownerOf, ipHashOf } from "./owner.ts";
import { realChain, explorerTx, type Chain } from "./chain.ts";
import { startRun, stepStart, endRun } from "./progress.ts";
import { executeSend, executeSwapRhea, simulate, ExecError, type Action, type ExecResult, type SendAction, type SwapAction, type SwapDeps } from "./executor.ts";
import { compareRoutes, rheaRoute } from "./quotes.ts";
import { getPrices } from "./research.ts";

export class ProposalError extends Error {} // a friendly message that is spoken to the owner as is
export class ApprovalError extends Error {}

export type Card = {
  id: string;
  hash: string;
  kind: "send" | "swap";
  mode: "rehearsal" | "live";
  network: "mainnet" | "testnet";
  title: string;
  lines: string[];
  warnings: string[];
  address?: string; // full destination address, shown in full so the owner can verify it
  to?: string; // the saved contact's name (a send), shown as the destination on the card
  usd: number;
  expiresAt: number;
};
type Status = "pending" | "executing" | "done" | "failed" | "rejected" | "expired";
type Pending = { id: string; session: string; action: Action; card: Card; usd: number; status: Status; contactName?: string };

export type Deps = {
  chain: () => Chain;
  usdPrice: (symbol: string) => Promise<number>;
  swapDeps: SwapDeps;
  now: () => number;
  compare: typeof compareRoutes;
};
export const defaultDeps = (): Deps => ({
  chain: realChain,
  usdPrice: async (symbol) => {
    const p = (await getPrices([symbol])).prices[0] as any;
    if (!p || !Number.isFinite(p.usd)) throw new ProposalError(`I can't get a price for ${symbol} right now, so I won't propose that.`);
    return p.usd;
  },
  swapDeps: { fetchRoute: rheaRoute },
  now: () => Date.now(),
  compare: compareRoutes,
});

const pending = new Map<string, Pending>(); // id -> pending action
const bySession = new Map<string, string>(); // session -> its one open card
// Real transactions go out one at a time. Two swaps at once would use the same key and interleave their steps.
let liveBusy = false;

const SEND_TOKENS = ["NEAR", "USDC", "USDT"];
const SWAP_TOKENS = ["NEAR", "USDC", "USDT"];
export const ACTIVITY = process.env.ORBI_ACTIVITY_FILE || fileURLToPath(new URL("../../../.data/activity.jsonl", import.meta.url));

// ---- shared-demo limits, all counted from the activity log so they survive a restart ----
function finishedToday(file: string, now: Date, keep: (e: any) => boolean): any[] {
  const out: any[] = [];
  try {
    if (!existsSync(file)) return out;
    const day = now.toISOString().slice(0, 10);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"done"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.event === "done" && e.ok === true && e.simulated === false && String(e.at).startsWith(day) && keep(e)) out.push(e);
      } catch {
        /* skip a damaged line */
      }
    }
  } catch {
    /* an unreadable log counts as nothing */
  }
  return out;
}
// How many real actions this visitor (browser) has finished today (UTC).
export const liveActionsToday = (owner: string, file: string = ACTIVITY, now = new Date()): number => finishedToday(file, now, (e) => e.owner === owner).length;
export const liveActionsTodayByIp = (ipHash: string, file: string = ACTIVITY, now = new Date()): number => finishedToday(file, now, (e) => e.ipHash === ipHash).length;
// Real sends finished today by everyone together, and their dollar value (joined to the proposal that carried the amount).
export function liveSendsToday(file: string = ACTIVITY, now = new Date()): { count: number; usd: number } {
  const done = finishedToday(file, now, () => true);
  if (!done.length) return { count: 0, usd: 0 };
  const sends = new Map<string, number>();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"proposed"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.event === "proposed" && e.action?.kind === "send") sends.set(e.id, Number(e.usd) || 0);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  const mine = done.filter((e) => sends.has(e.id));
  return { count: mine.length, usd: mine.reduce((t, e) => t + (sends.get(e.id) ?? 0), 0) };
}
// On a shared demo each browser and each network address may run only a few real actions a day.
// Returns the sentence to say, or null if it may proceed.
export function visitorCapReason(session: string, file?: string): string | null {
  if (!multiUser() || config.executionMode !== "live") return null;
  const owner = ownerOf(session);
  const capBrowser = config.maxLiveActionsPerVisitor;
  const capIp = config.maxLiveActionsPerIp;
  if (capBrowser > 0) {
    if (!owner) return "I can't tell who you are yet. Reload the page and try again.";
    if (liveActionsToday(owner, file) >= capBrowser)
      return `You've used your ${capBrowser} real actions for today on this shared demo, so others can have a turn. I can still look up prices, rates and quotes for you.`;
  }
  if (capIp > 0) {
    const ip = ipHashOf(session);
    if (!ip) return "I can't tell where you are connecting from, so I can't start a real action. Reload the page and try again.";
    if (liveActionsTodayByIp(ip, file) >= capIp)
      return `This connection has used its ${capIp} real actions for today on the shared demo, so others can have a turn. I can still look up prices, rates and quotes for you.`;
  }
  return null;
}
// Sends all go to one wallet, so a shared demo also caps them on their own, to keep the demo wallet from being emptied.
export function sendCapReason(file?: string): string | null {
  if (!multiUser() || config.executionMode !== "live") return null;
  const { maxLiveSendsPerDay: n, maxLiveSendUsdPerDay: usd } = config;
  if (n <= 0 && usd <= 0) return null;
  const t = liveSendsToday(file);
  if ((n > 0 && t.count >= n) || (usd > 0 && t.usd >= usd))
    return "The demo's sends to Treasury have reached today's limit, so the wallet keeps enough to swap. Swaps still work, and I can look things up too.";
  return null;
}

export function audit(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(ACTIVITY), { recursive: true });
    const owner = ownerOf(entry.session as string | undefined); // set only on a hosted copy: keeps each visitor's history apart
    const ipHash = ipHashOf(entry.session as string | undefined); // a short one-way hash, never the address itself
    appendFileSync(ACTIVITY, JSON.stringify({ at: new Date().toISOString(), ...(owner ? { owner } : {}), ...(ipHash ? { ipHash } : {}), ...entry }) + "\n");
  } catch {
    /* logging must never break an action */
  }
}

const hashOf = (action: Action, id: string) =>
  createHash("sha256").update(JSON.stringify({ id, action, mode: config.executionMode, network: config.network, account: config.agentAccount })).digest("hex");

function parseAmount(raw: unknown, decimals: number): string {
  const s = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ProposalError("I didn't get a valid amount.");
  if (!(Number(s) > 0)) throw new ProposalError("The amount has to be more than zero.");
  try {
    toUnits(s, decimals);
  } catch {
    throw new ProposalError("That amount has too many decimal places.");
  }
  return s;
}
const shown = (n: string | number) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 }); // display only: the exact units are kept separately
const usd2 = (n: number) => (n < 0.01 ? "less than a cent" : `$${n.toFixed(2)}`);
const looksLikeAddress = (s: string) => /[.]/.test(s) || /^[0-9a-f]{40,}$/i.test(s.replace(/\s/g, ""));

function open(session: string, p: Omit<Pending, "id" | "card"> & { card: Omit<Card, "id" | "hash" | "expiresAt" | "mode" | "network"> }, deps: Deps): Card {
  if (config.executionMode === "off") throw new ProposalError("Sending and swapping are turned off right now. I can still look up rates, prices and quotes.");
  const old = bySession.get(session);
  if (old) {
    const o = pending.get(old);
    if (o && o.status === "pending") o.status = "rejected"; // a new proposal replaces the open one
  }
  const id = randomUUID();
  const card: Card = { ...p.card, id, hash: hashOf(p.action, id), mode: config.executionMode as "rehearsal" | "live", network: config.network, expiresAt: deps.now() + config.pendingTtlSec * 1000 };
  pending.set(id, { id, session, action: p.action, usd: p.usd, status: "pending", contactName: p.contactName, card });
  bySession.set(session, id);
  audit({ event: "proposed", session, id, action: p.action, usd: p.usd, mode: config.executionMode, network: config.network });
  return card;
}

// ---------------- propose: send ----------------
export async function proposeSend(session: string, input: { token: string; amount: unknown; to_name: string }, policy: PolicyState, deps: Deps = defaultDeps()): Promise<Card> {
  const capped = visitorCapReason(session);
  if (capped) throw new ProposalError(capped);
  const sendCapped = sendCapReason();
  if (sendCapped) throw new ProposalError(sendCapped);
  const symbol = String(input.token ?? "").toUpperCase();
  if (!SEND_TOKENS.includes(symbol)) throw new ProposalError(`I can send ${SEND_TOKENS.join(", ")}. I can't send ${input.token || "that"}.`);
  const token = findToken(symbol);
  const amount = parseAmount(input.amount, token.decimals);
  const spoken = String(input.to_name ?? "").trim();
  if (!spoken) throw new ProposalError("Who should I send it to? Tell me the name of a saved contact.");
  if (looksLikeAddress(spoken)) throw new ProposalError("I don't take addresses by voice, because one misheard letter would send the money to the wrong place. Save the address as a contact first, then ask me by name.");
  const contact = resolveContact(spoken, ownerOf(session));
  if (!contact) throw new ProposalError(`I don't have a contact called ${spoken}. Add them in Settings, under Contacts, and ask again.`);

  const usd = Number(amount) * (await deps.usdPrice(symbol));
  const verdict = checkAction(usd, policy);
  if (!verdict.allowed) throw new ProposalError(`I can't do that one: ${verdict.reason} I'd need you to raise my limit in the settings.`);
  const warnings: string[] = [];
  if (contact.sends === 0) {
    if (usd > config.maxNewAddressUsd) throw new ProposalError(`${contact.name} hasn't been paid before, so my limit for a first payment is ${usd2(config.maxNewAddressUsd)}. Try a smaller amount first.`);
    warnings.push(`First payment to ${contact.name}. Check the address carefully.`);
  }
  if (config.executionMode === "live") {
    const chain = deps.chain();
    const reserve = BigInt(Math.round(config.minNativeReserveNear * 1e6)) * 10n ** 18n;
    const native = await chain.nativeBalance();
    if (!token.contract) {
      if (native < BigInt(toUnits(amount, 24)) + reserve) throw new ProposalError(`I don't have enough NEAR for that. I have ${fromUnits(native, 24, 3)} and keep ${config.minNativeReserveNear} aside for fees.`);
    } else {
      const bal = BigInt(await chain.view<string>(token.contract, "ft_balance_of", { account_id: chain.accountId }));
      if (bal < BigInt(toUnits(amount, token.decimals))) throw new ProposalError(`I only have ${fromUnits(bal, token.decimals)} ${symbol}.`);
    }
  } else warnings.push("Rehearsal mode: approving will not send anything.");

  const action: SendAction = { kind: "send", token: symbol, amount, toName: contact.name, toAddress: contact.address };
  return open(session, { session, action, usd, status: "pending", contactName: contact.name, card: { kind: "send", to: contact.name, title: `Send ${amount} ${symbol} to ${contact.name}`, lines: [`Amount: ${amount} ${symbol} (about ${usd2(usd)})`, `To: ${contact.name}`, "Network fee: about 0.001 NEAR, or about 0.007 NEAR (a few cents) if this creates a new account"], warnings, address: contact.address, usd } }, deps);
}

// ---------------- propose: swap ----------------
export async function proposeSwap(session: string, input: { from_token: string; to_token: string; amount: unknown }, policy: PolicyState, deps: Deps = defaultDeps()): Promise<Card> {
  const capped = visitorCapReason(session);
  if (capped) throw new ProposalError(capped);
  const from = String(input.from_token ?? "").toUpperCase(), to = String(input.to_token ?? "").toUpperCase();
  if (!SWAP_TOKENS.includes(from) || !SWAP_TOKENS.includes(to)) throw new ProposalError(`I can swap between ${SWAP_TOKENS.join(", ")}.`);
  if (from === to) throw new ProposalError("Those are the same token.");
  if (config.executionMode === "live" && config.network !== "mainnet") throw new ProposalError("Swaps only exist on mainnet. This is the test network, so I can send but not swap.");
  const fromTok = findToken(from), toTok = findToken(to);
  const amount = parseAmount(input.amount, fromTok.decimals);
  const { routes, errors } = await deps.compare(from, to, amount);
  const rhea = routes.find((r) => r.source === "Rhea SmartRouter");
  if (!rhea) throw new ProposalError(`I can't find a route I'm able to run right now.${errors.length ? " The router isn't answering." : ""}`);
  const usd = Number(amount) * (await deps.usdPrice(from));
  const verdict = checkAction(usd, policy);
  if (!verdict.allowed) throw new ProposalError(`I can't do that one: ${verdict.reason} I'd need you to raise my limit in the settings.`);
  const warnings: string[] = [];
  const intents = routes.find((r) => r.source === "NEAR Intents");
  if (intents && intents.amountOutUnits > rhea.amountOutUnits) warnings.push(`NEAR Intents shows about ${shown(intents.amountOut)} ${to}, slightly more, but swaps through it aren't enabled yet.`);
  warnings.push(`Estimate: if the price moves more than ${config.maxDriftPct}% before you approve, I'll cancel instead of swapping.`);
  if (config.executionMode === "rehearsal") warnings.push("Rehearsal mode: approving will not send anything.");
  const fee = rhea.orbiFeePct > 0 ? `Orbi fee: ${rhea.orbiFeePct}% (included in the estimate)` : "Orbi fee: none";
  const action: SwapAction = { kind: "swap", from, to, amount, route: "Rhea SmartRouter", estOut: rhea.amountOut, estOutUnits: rhea.amountOutUnits.toString() };
  return open(session, { session, action, usd, status: "pending", card: { kind: "swap", title: `Swap ${amount} ${from} for about ${shown(rhea.amountOut)} ${to}`, lines: [`You give: ${amount} ${from} (about ${usd2(usd)})`, `You get: about ${shown(rhea.amountOut)} ${to}`, "Route: Rhea", fee, "Network fees: up to about 0.03 NEAR for the swap, plus one-time registrations of about 0.04 NEAR the first time"], warnings, usd } }, deps);
}

// ---------------- approve / reject ----------------
export type Approval = { ok: boolean; simulated: boolean; spoken: string; lines: string[]; txs: ExecResult["txs"] };

export async function approve(session: string, id: string, hash: string, policy: PolicyState, deps: Deps = defaultDeps()): Promise<Approval> {
  const p = pending.get(id);
  if (!p || p.session !== session) throw new ApprovalError("I can't find that card. Ask me again.");
  if (p.status !== "pending") throw new ApprovalError(p.status === "executing" ? "That one is already running." : p.status === "done" ? "That one was already done." : "That card is no longer open. Ask me again.");
  if (deps.now() > p.card.expiresAt) {
    p.status = "expired";
    throw new ApprovalError("That card expired, so I didn't do anything. Ask me again for a fresh one.");
  }
  if (hash !== p.card.hash || hashOf(p.action, p.id) !== p.card.hash) throw new ApprovalError("What you approved doesn't match this card, so I stopped. Ask me again.");
  const verdict = checkAction(p.usd, policy, undefined, new Date(deps.now()));
  if (!verdict.allowed) {
    p.status = "failed";
    throw new ApprovalError(`I stopped: ${verdict.reason}`);
  }
  const capped = visitorCapReason(session); // checked again here: several cards may have been opened before the cap was reached
  if (capped) throw new ApprovalError(capped);
  if (p.action.kind === "send") {
    const sendCapped = sendCapReason();
    if (sendCapped) throw new ApprovalError(sendCapped);
  }
  const locked = config.executionMode === "live";
  if (locked && liveBusy) throw new ApprovalError("Another approval is being processed right now. Wait a few seconds and tap Approve again. Nothing was done."); // the card stays open
  if (locked) liveBusy = true;
  p.status = "executing"; // set before any await so a double tap cannot run it twice
  startRun(id, session);
  const onStep = (label: string) => stepStart(id, label);
  audit({ event: "approved", session, id, action: p.action, mode: config.executionMode });
  try {
    let result: ExecResult;
    if (config.executionMode === "rehearsal") result = simulate(p.action);
    else if (config.executionMode === "live") {
      const chain = deps.chain();
      result = p.action.kind === "send" ? await executeSend(p.action, chain, onStep) : await executeSwapRhea(p.action, chain, deps.swapDeps, onStep);
      recordSpend(p.usd, policy);
      if (p.action.kind === "send" && p.contactName) recordSend(p.contactName, ownerOf(session));
    } else throw new ApprovalError("Sending and swapping are turned off right now.");
    p.status = "done";
    endRun(id, result.ok);
    audit({ event: "done", session, id, ok: result.ok, simulated: Boolean(result.simulated), txs: result.txs.map((t) => t.hash) });
    return { ok: result.ok, simulated: Boolean(result.simulated), spoken: result.spoken, lines: result.lines, txs: result.txs };
  } catch (e) {
    p.status = "failed";
    endRun(id, false);
    const msg = e instanceof ExecError || e instanceof ApprovalError ? e.message : "Something went wrong and I stopped. Please check the wallet before trying again.";
    audit({ event: "failed", session, id, error: (e as Error).message });
    throw new ApprovalError(msg);
  } finally {
    if (locked) liveBusy = false;
  }
}

export function reject(session: string, id: string): boolean {
  const p = pending.get(id);
  if (!p || p.session !== session || p.status !== "pending") return false;
  p.status = "rejected";
  audit({ event: "rejected", session, id });
  return true;
}

export const openCard = (session: string): Card | null => {
  const id = bySession.get(session);
  const p = id ? pending.get(id) : undefined;
  return p && p.status === "pending" ? p.card : null;
};

export function resetActionsForTests() {
  pending.clear();
  bySession.clear();
}
export { explorerTx };
