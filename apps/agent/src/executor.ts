// Builds and sends the real transactions. Written against the `Chain` interface so every step can be tested with a
// recording fake. Nothing in here is reachable by the model: only an approved pending action gets this far.
import { config } from "./config.ts";
import { TGAS, explorerTx, type Chain, type TxResult } from "./chain.ts";
import { findToken, fromUnits, toUnits } from "./tokens.ts";
import { applyFee, type RheaRoute } from "./quotes.ts";

export const AGGREGATOR = "aggregatedex.near";
const NEAR_YOCTO = 10n ** 24n;
const reserveYocto = () => BigInt(Math.round(config.minNativeReserveNear * 1e6)) * 10n ** 18n;
const GAS_MARGIN = NEAR_YOCTO / 20n; // 0.05 NEAR kept free for the gas of a swap

export type SendAction = { kind: "send"; token: string; amount: string; toName: string; toAddress: string };
export type SwapAction = { kind: "swap"; from: string; to: string; amount: string; route: string; estOut: string; estOutUnits: string };
export type Action = SendAction | SwapAction;
export type ExecResult = { ok: boolean; simulated?: boolean; txs: { label: string; hash: string; url: string }[]; spoken: string; lines: string[] };

export type OnStep = (label: string) => void;   // tells the card what is happening now; never changes what happens
export class ExecError extends Error {}
const fail = (msg: string): never => {
  throw new ExecError(msg);
};
const yocto = (nearAmount: bigint) => `${fromUnits(nearAmount, 24, 4)} NEAR`;
const tx = (label: string, r: TxResult) => ({ label, hash: r.txHash, url: explorerTx(r.txHash) });
function must(label: string, r: TxResult): TxResult {
  if (!r.ok) throw new ExecError(`${label} failed on-chain: ${r.failure ?? "unknown error"}`);
  return r;
}

// ---------- send ----------
export async function executeSend(a: SendAction, chain: Chain, onStep: OnStep = () => {}): Promise<ExecResult> {
  const token = findToken(a.token);
  const txs: ExecResult["txs"] = [];
  const reserve = reserveYocto();
  onStep("Checking the balance");
  const native = await chain.nativeBalance();

  if (!token.contract) {
    const amount = BigInt(toUnits(a.amount, 24));
    if (native < amount + reserve) fail(`Not enough NEAR: I have ${yocto(native)} and keep ${yocto(reserve)} aside for fees.`);
    const isImplicit = /^[0-9a-f]{64}$/.test(a.toAddress);
    if (!isImplicit && !(await chain.accountExists(a.toAddress))) fail(`The account ${a.toAddress} doesn't exist yet, so I won't send there.`);
    onStep(`Sending ${a.amount} NEAR to ${a.toName}`);
    const r = must("The transfer", await chain.transferNative(a.toAddress, amount));
    txs.push(tx("Transfer", r));
    return { ok: true, txs, spoken: `Done. I sent ${a.amount} NEAR to ${a.toName}.`, lines: [`Sent ${a.amount} NEAR to ${a.toName}`] };
  }

  const amountUnits = BigInt(toUnits(a.amount, token.decimals));
  const balance = BigInt(await chain.view<string>(token.contract, "ft_balance_of", { account_id: chain.accountId }));
  if (balance < amountUnits) fail(`Not enough ${token.symbol}: I have ${fromUnits(balance, token.decimals)}.`);
  // The receiver must be registered with the token contract, or the transfer fails. Register them if needed.
  const reg = await chain.view<unknown>(token.contract, "storage_balance_of", { account_id: a.toAddress });
  if (reg === null) {
    const bounds = await chain.view<{ min: string }>(token.contract, "storage_balance_bounds", {});
    const cost = BigInt(bounds.min);
    if (native < cost + reserve) fail(`Not enough NEAR to register ${a.toName} with ${token.symbol} (${yocto(cost)}).`);
    onStep(`Registering ${a.toName} with ${token.symbol}`);
    const r = must("Registering the receiver", await chain.call(token.contract, "storage_deposit", { account_id: a.toAddress, registration_only: true }, { depositYocto: cost, gas: 30n * TGAS }));
    txs.push(tx(`Register ${a.toName} with ${token.symbol}`, r));
  }
  onStep(`Sending ${a.amount} ${token.symbol} to ${a.toName}`);
  const r = must("The transfer", await chain.call(token.contract, "ft_transfer", { receiver_id: a.toAddress, amount: amountUnits.toString() }, { depositYocto: 1n, gas: 30n * TGAS, waitUntil: "FINAL" }));
  txs.push(tx("Transfer", r));
  return { ok: true, txs, spoken: `Done. I sent ${a.amount} ${token.symbol} to ${a.toName}.`, lines: [`Sent ${a.amount} ${token.symbol} to ${a.toName}`] };
}

// ---------- swap through Rhea SmartRouterV2 ----------
export type SwapDeps = { fetchRoute: (from: string, to: string, amount: string) => Promise<{ route: RheaRoute; feeOn: boolean }> };

export async function executeSwapRhea(a: SwapAction, chain: Chain, deps: SwapDeps, onStep: OnStep = () => {}): Promise<ExecResult> {
  const from = findToken(a.from);
  const to = findToken(a.to);
  const txs: ExecResult["txs"] = [];
  const reserve = reserveYocto();
  const me = chain.accountId;
  const amountIn = BigInt(toUnits(a.amount, from.decimals));

  // 1. A fresh route (quotes are short-lived), and a drift check against what the owner approved.
  onStep("Getting a fresh route from Rhea");
  const { route, feeOn } = await deps.fetchRoute(a.from, a.to, a.amount);
  const gross = BigInt(route.amount_out);
  const fresh = feeOn ? applyFee(gross, config.feePerMille) : gross;
  const approved = BigInt(a.estOutUnits);
  const floor = (approved * BigInt(Math.round((100 - config.maxDriftPct) * 100))) / 10000n;
  if (fresh < floor) fail(`The price moved: you approved about ${fromUnits(approved, to.decimals)} ${to.symbol} but it's now about ${fromUnits(fresh, to.decimals)}. Ask me again to get a new quote.`);

  onStep("Checking the price has not moved");
  // 2. Registrations the router needs: the user on the aggregator, and the user, aggregator and fee recipient on every token of the route.
  const tokens = route.tokens;
  const native = await chain.nativeBalance();
  // On the router itself the user AND the fee recipient (when a fee is used) must be registered for every token of the route.
  const routerAccounts = [me, ...(feeOn && config.feeRecipient && config.feeRecipient !== me ? [config.feeRecipient] : [])];
  const routerTodo: { account: string; tokens: string[] }[] = [];
  for (const acct of routerAccounts) {
    const registered = await chain.view<boolean[]>(AGGREGATOR, "query_user_tokens_registered", { user: acct, tokens });
    const missing = tokens.filter((_, i) => registered[i] !== true);
    if (missing.length) routerTodo.push({ account: acct, tokens: missing });
  }
  const holders = [me, AGGREGATOR, ...(feeOn ? [config.feeRecipient] : [])];
  const storageTodo: { token: string; account: string }[] = [];
  for (const t of tokens) for (const acct of holders) {
    if ((await chain.view<unknown>(t, "storage_balance_of", { account_id: acct })) === null) storageTodo.push({ token: t, account: acct });
  }
  if (from.contract === null) {
    const wrapReg = await chain.view<unknown>("wrap.near", "storage_balance_of", { account_id: me });
    if (wrapReg === null && !storageTodo.some((s) => s.token === "wrap.near" && s.account === me)) storageTodo.push({ token: "wrap.near", account: me });
  }
  const perToken = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR: the minimum and maximum storage deposit on these tokens
  const aggregatorCost = 5_000_000_000_000_000_000_000n * BigInt(routerTodo.reduce((n, r) => n + r.tokens.length, 0)); // 0.005 NEAR per token per account
  const storageCost = perToken * BigInt(storageTodo.length);
  const wrapCost = from.contract === null ? amountIn : 0n;
  const need = aggregatorCost + storageCost + wrapCost + reserve + GAS_MARGIN;
  if (native < need) fail(`Not enough NEAR for this swap: I need about ${yocto(need)} (registrations ${yocto(aggregatorCost + storageCost)}, fees and reserve ${yocto(reserve + GAS_MARGIN)}${wrapCost ? `, swap ${yocto(wrapCost)}` : ""}) and have ${yocto(native)}.`);
  if (from.contract !== null) {
    const have = BigInt(await chain.view<string>(from.contract, "ft_balance_of", { account_id: me }));
    if (have < amountIn) fail(`Not enough ${from.symbol}: I have ${fromUnits(have, from.decimals)}.`);
  }
  // The router pays out the TOKEN, so a swap "into NEAR" arrives as wNEAR (wrap.near). It is measured as wNEAR and then unwrapped to plain NEAR below.
  const outToken = to.contract === null ? "wrap.near" : to.contract;
  const before = BigInt(await chain.view<string>(outToken, "ft_balance_of", { account_id: me }));

  // 3. Register what is missing.
  if (storageTodo.length || routerTodo.length) onStep("Registering Orbi's accounts (one time)");
  for (const s of storageTodo) {
    const r = must(`Registering ${s.account} on ${s.token}`, await chain.call(s.token, "storage_deposit", { account_id: s.account, registration_only: true }, { depositYocto: perToken, gas: 30n * TGAS }));
    txs.push(tx(`Register ${s.account === me ? "Orbi" : s.account} on ${s.token}`, r));
  }
  for (const r of routerTodo) {
    const cost = 5_000_000_000_000_000_000_000n * BigInt(r.tokens.length);
    const res = must("Registering on the router", await chain.call(AGGREGATOR, "tokens_storage_deposit", { user: r.account, tokens: r.tokens }, { depositYocto: cost, gas: 50n * TGAS }));
    txs.push(tx(`Register ${r.account === me ? "Orbi" : "the fee wallet"} on the router`, res));
  }

  // 4. Native NEAR has to be wrapped first.
  if (from.contract === null) {
    onStep("Wrapping NEAR");
    const r = must("Wrapping NEAR", await chain.call("wrap.near", "near_deposit", {}, { depositYocto: amountIn, gas: 10n * TGAS }));
    txs.push(tx("Wrap NEAR", r));
  }

  // 5. The swap itself: ft_transfer_call to the router with its signed route.
  onStep(`Swapping ${a.amount} ${from.symbol} on Rhea`);
  const r = must("The swap", await chain.call(from.swapContract, "ft_transfer_call", { receiver_id: AGGREGATOR, amount: amountIn.toString(), msg: JSON.stringify({ msg: route.msg, signature: route.signature }) }, { depositYocto: 1n, gas: 300n * TGAS, waitUntil: "FINAL" }));
  txs.push(tx("Swap", r));

  // 6. Report what really arrived, not what was promised.
  onStep("Checking what arrived");
  const afterBal = BigInt(await chain.view<string>(outToken, "ft_balance_of", { account_id: me }));
  const got = afterBal - before;
  if (to.contract === null && got > 0n) {   // turn the wNEAR that arrived back into plain NEAR
    onStep("Unwrapping to NEAR");
    const u = must("Unwrapping to NEAR", await chain.call("wrap.near", "near_withdraw", { amount: got.toString() }, { depositYocto: 1n, gas: 30n * TGAS }));
    txs.push(tx("Unwrap to NEAR", u));
  }
  const gotText = got > 0n ? `${fromUnits(got, to.decimals, 4)} ${to.symbol}` : "nothing yet";
  const ok = got > 0n;
  return {
    ok,
    txs,
    spoken: ok ? `Done. I swapped ${a.amount} ${from.symbol} and received about ${gotText}.` : `The swap went through on-chain, but I don't see the ${to.symbol} yet. Check the transaction link.`,
    lines: [`Swapped ${a.amount} ${from.symbol} via Rhea`, `Received ${gotText}`],
  };
}

// ---------- rehearsal: the same card and flow, nothing signed ----------
export function simulate(a: Action): ExecResult {
  const what = a.kind === "send" ? `send ${a.amount} ${a.token} to ${a.toName}` : `swap ${a.amount} ${a.from} for about ${Number(a.estOut).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${a.to}`;
  return {
    ok: true,
    simulated: true,
    txs: [{ label: "SIMULATED (nothing was sent)", hash: "SIMULATED", url: "" }],
    spoken: `Rehearsal only. I didn't send anything. In live mode I would ${what}.`,
    lines: [`Rehearsal: no transaction was signed or sent`, `Live mode would ${what}`],
  };
}
