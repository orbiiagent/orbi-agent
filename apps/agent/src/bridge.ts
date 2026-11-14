// Bring USDC in from Base (for example from an exchange that cannot withdraw to NEAR) and receive NEAR in Orbi's wallet,
// through NEAR Intents 1Click: one deposit on Base, and a solver bridges and swaps in one step.
//
// Orbi signs NOTHING here and holds no Base key. It asks Intents for a deposit address, shows it on a card, and the owner
// sends the USDC from their own wallet or exchange. What the owner sends is theirs until they send it; Orbi cannot move it.
// Safety rules kept in code: the address on the card is the one Intents returned (format-checked), the refund address is the
// owner's own (typed in Settings, never spoken), the amount is capped, and mainnet only.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { fromUnits, toUnits } from "./tokens.ts";
import { nativeBalance } from "./near.ts";
import { audit } from "./actions.ts";
import { ensureDir, multiUser, ownerOf, scoped } from "./owner.ts";

export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const NEAR_OUT = "nep141:wrap.near";

export class BridgeError extends Error {} // a friendly message that is spoken as is

// ---------- the owner's own Base address, used only as the refund address ----------
const SETTINGS = (owner?: string) => scoped(process.env.ORBI_BRIDGE_FILE || fileURLToPath(new URL("../../../.data/bridge.json", import.meta.url)), "bridge.json", owner);
export function validBaseAddress(raw: string): string | null {
  const a = String(raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  const lower = a.toLowerCase();
  if (/^0x0{40}$/.test(lower) || lower === "0x000000000000000000000000000000000000dead") return null;
  return lower; // lowercase: the API rejects a mixed-case address with a wrong checksum
}
export function getRefundAddress(owner?: string): string | null {
  // On a hosted copy the machine-wide address in .env is nobody's: each visitor must give their own.
  const fromEnv = multiUser() ? null : validBaseAddress(process.env.ORBI_BASE_REFUND_ADDRESS ?? "");
  if (fromEnv) return fromEnv;
  try {
    return validBaseAddress(JSON.parse(readFileSync(SETTINGS(owner), "utf8")).refundBase ?? "");
  } catch {
    return null;
  }
}
export function setRefundAddress(raw: string, owner?: string): string {
  const a = validBaseAddress(raw);
  if (!a) throw new BridgeError("That doesn't look like a Base address. It starts with 0x and has 40 more letters and digits.");
  ensureDir(SETTINGS(owner));
  writeFileSync(SETTINGS(owner), JSON.stringify({ refundBase: a }, null, 2) + "\n", { mode: 0o600 });
  return a;
}

// ---------- the deposit card ----------
export type DepositCard = {
  id: string;
  kind: "deposit";
  mode: "live";
  network: "mainnet";
  title: string;
  lines: string[];
  warnings: string[];
  address: string; // the deposit address on Base, shown in full
  amount: string; // exactly this much USDC
  usd: number;
  expiresAt: number;
};
type Deposit = { id: string; session: string; card: DepositCard; depositAddress: string; deadline: number; settled?: boolean; result?: DepositStatus };
const deposits = new Map<string, Deposit>();
const bySession = new Map<string, string>();

export type BridgeDeps = { fetch: typeof fetch; nativeBalance: (a: string) => Promise<bigint>; now: () => number };
const defaults = (): BridgeDeps => ({ fetch: (...a) => fetch(...a), nativeBalance, now: () => Date.now() });
const headers = () => ({ "Content-Type": "application/json", ...(config.intentsJwt ? { Authorization: `Bearer ${config.intentsJwt}` } : {}) });
const money = (n: number) => `$${n.toFixed(2)}`;

export async function proposeDeposit(session: string, input: { amount: unknown }, deps: BridgeDeps = defaults()): Promise<DepositCard> {
  if (config.network !== "mainnet") throw new BridgeError("Bringing funds in only works on mainnet, and this is the test network.");
  if (config.executionMode === "off") throw new BridgeError("I'm in read-only mode right now, so I'm not setting up deposits.");
  if (multiUser()) throw new BridgeError("Bringing money in is switched off on this shared demo, because the wallet here is a test wallet. Run Orbi yourself to try it.");
  if (!config.agentAccount) throw new BridgeError("My wallet isn't set up yet.");
  const raw = typeof input.amount === "number" ? String(input.amount) : String(input.amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw) || !(Number(raw) > 0)) throw new BridgeError("How much USDC do you want to bring in?");
  let units: string;
  try {
    units = toUnits(raw, 6);
  } catch {
    throw new BridgeError("USDC only goes down to six decimal places.");
  }
  const amount = fromUnits(units, 6);
  if (Number(amount) > config.maxBridgeUsd) throw new BridgeError(`That's above my limit of ${money(config.maxBridgeUsd)} for one deposit. Try a smaller amount, or raise the limit in the settings.`);
  const refund = getRefundAddress(ownerOf(session));
  if (!refund) throw new BridgeError("Before I set up a deposit I need your own Base address, in case it has to be refunded. Paste it in Settings under Bridge, then ask me again.");

  const deadline = deps.now() + config.bridgeDeadlineMin * 60_000;
  const res = await deps.fetch(`${config.intentsApi}/v0/quote`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: Math.round(config.slippage * 10000),
      originAsset: BASE_USDC,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: NEAR_OUT,
      amount: units,
      recipient: config.agentAccount,
      recipientType: "DESTINATION_CHAIN",
      refundTo: refund,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(deadline).toISOString(),
    }),
  }).catch(() => {
    throw new BridgeError("I couldn't reach the bridge just now. Try again in a moment.");
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = String(body?.message ?? "").toLowerCase();
    if (/too low|minimum|below/.test(why)) throw new BridgeError("That's below the bridge's minimum. Try a bit more.");
    if (/liquidity|no route|not enough/.test(why)) throw new BridgeError("The bridge can't fill an amount like that right now. Try a different amount.");
    throw new BridgeError("The bridge couldn't set that up right now. Nothing was started. Try again in a moment.");
  }
  const q = body.quote ?? {};
  const depositAddress = String(q.depositAddress ?? "").toLowerCase();
  // Never show an address that is not exactly what a Base deposit address looks like.
  if (!/^0x[0-9a-f]{40}$/.test(depositAddress)) throw new BridgeError("The bridge sent back something I don't trust, so I stopped. Nothing was started.");
  if (String(q.amountIn ?? units) !== units) throw new BridgeError("The bridge changed the amount, so I stopped. Nothing was started.");

  const outNear = Number(fromUnits(String(q.amountOut ?? "0"), 24, 4));
  const usd = Number(q.amountInUsd) || Number(amount);
  const minOutNear = q.minAmountOut ? Number(fromUnits(String(q.minAmountOut), 24, 4)) : undefined;
  const eta = Number(q.timeEstimate) > 0 ? Math.max(1, Math.round(Number(q.timeEstimate) / 60)) : 1;
  const warnings = [
    "Send only USDC on the Base network to this address. Any other coin or network can be lost for good.",
    `Send exactly ${amount} USDC. Less than that is refunded to your Base address, and the deposit address stops working after the time shown.`,
    "Use this address once, and don't save it for later.",
  ];
  if ((await deps.nativeBalance(config.agentAccount).catch(() => 1n)) === 0n) warnings.unshift("My wallet doesn't exist on the NEAR network yet, so this first deposit also creates it. Start small, like 3 USDC, and check it arrived before sending more.");
  const card: DepositCard = {
    id: randomUUID(),
    kind: "deposit",
    mode: "live",
    network: "mainnet",
    title: `Bring in ${amount} USDC from Base`,
    lines: [
      `Send exactly: ${amount} USDC on Base`,
      `You get: about ${outNear} NEAR${minOutNear ? ` (at least ${minOutNear})` : ""}, fee included`,
      `Arrives: about ${eta} minute${eta > 1 ? "s" : ""} after your deposit lands`,
      "Goes to: Orbi's wallet",
      `Refund to: your Base address ending ${refund.slice(-6)}`,
    ],
    warnings,
    address: depositAddress,
    amount,
    usd,
    expiresAt: deadline,
  };
  const old = bySession.get(session);
  if (old) deposits.delete(old);
  deposits.set(card.id, { id: card.id, session, card, depositAddress, deadline });
  bySession.set(session, card.id);
  audit({ event: "deposit_created", session, id: card.id, amount, estNear: outNear, network: config.network });
  return card;
}

export const openDeposit = (session: string): DepositCard | null => {
  const id = bySession.get(session);
  const d = id ? deposits.get(id) : undefined;
  return d && d.deadline > Date.now() && !d.settled ? d.card : null;
};

// ---------- where is the deposit? ----------
export type DepositState = "waiting" | "processing" | "done" | "refunded" | "failed" | "expired";
export type DepositStatus = { state: DepositState; spoken: string; line: string; txUrl?: string };

const STATES: Record<string, DepositState> = { PENDING_DEPOSIT: "waiting", KNOWN_DEPOSIT_TX: "processing", PROCESSING: "processing", SUCCESS: "done", INCOMPLETE_DEPOSIT: "waiting", REFUNDED: "refunded", FAILED: "failed" };

export async function depositStatus(session: string, id?: string, deps: BridgeDeps = defaults()): Promise<DepositStatus> {
  const d = deposits.get(id ?? bySession.get(session) ?? "");
  if (!d || d.session !== session) throw new BridgeError("I don't have a deposit open. Ask me to bring some in first.");
  if (d.result) return d.result; // already done: do not ask or log again
  let state: DepositState = "waiting";
  let detail: any = {};
  try {
    const res = await deps.fetch(`${config.intentsApi}/v0/status?depositAddress=${encodeURIComponent(d.depositAddress)}`, { headers: headers(), signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const b: any = await res.json();
      state = STATES[String(b.status)] ?? "waiting";
      detail = b.swapDetails ?? {};
      if (String(b.status) === "INCOMPLETE_DEPOSIT") return { state, spoken: "Your deposit came in a bit short, so it's waiting for the rest. Send the difference, or it will be refunded.", line: "Deposit is short of the amount. Send the rest, or it will be refunded." };
    }
    // a 404 just means the deposit has not been seen yet
  } catch {
    return { state: "waiting", spoken: "I couldn't check the bridge just now. Try again in a moment.", line: "Couldn't check just now. Trying again…" };
  }
  if (state === "waiting" && deps.now() > d.deadline) state = "expired";
  if (state === "done") {
    d.settled = true;
    const got = detail.amountOutFormatted ? `about ${Number(detail.amountOutFormatted).toFixed(2)} NEAR` : "your NEAR";
    const hash = detail.destinationChainTxHashes?.[0]?.hash;
    audit({ event: "deposit_done", session, id: d.id, txs: hash ? [hash] : [], network: config.network });
    d.result = { state, spoken: `It arrived! ${got.charAt(0).toUpperCase() + got.slice(1)} is in my wallet now.`, line: `Done. ${got} arrived in Orbi's wallet.`, txUrl: hash ? `https://nearblocks.io/txns/${hash}` : undefined };
    return d.result;
  }
  const say: Record<Exclude<DepositState, "done">, [string, string]> = {
    waiting: ["Nothing has arrived yet. Send the USDC to the address on the card.", "Waiting for your deposit…"],
    processing: ["I can see your deposit, and the bridge is working on it. It should take about a minute.", "Deposit received. Bridging and swapping now…"],
    refunded: ["That deposit was refunded to your Base address, so nothing came in.", "Refunded to your Base address."],
    failed: ["The bridge couldn't finish that one. If you sent funds, they should be refunded to your Base address.", "The bridge couldn't finish. Funds go back to your Base address."],
    expired: ["That deposit window closed before anything arrived. Ask me for a fresh address if you still want to bring funds in.", "Expired. Ask for a fresh address."],
  };
  const [spoken, line] = say[state];
  return { state, spoken, line };
}

export function resetBridgeForTests() {
  deposits.clear();
  bySession.clear();
}
