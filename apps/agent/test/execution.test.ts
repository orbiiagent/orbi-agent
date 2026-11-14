import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Contacts and the activity log go to a throwaway folder, never the real .data
const dir = mkdtempSync(`${tmpdir()}/orbi-exec-`);
process.env.ORBI_CONTACTS_FILE = `${dir}/contacts.json`;
process.env.ORBI_ACTIVITY_FILE = `${dir}/activity.jsonl`;

const { config } = await import("../src/config.ts");
const { executeSend, executeSwapRhea, AGGREGATOR, ExecError } = await import("../src/executor.ts");
const { proposeSend, proposeSwap, approve, reject, openCard, ApprovalError, ProposalError, resetActionsForTests } = await import("../src/actions.ts");
const { addContact, listContacts, removeContact } = await import("../src/contacts.ts");
const { newPolicyState } = await import("../src/policy.ts");
type Chain = import("../src/chain.ts").Chain;

const ME = "c6473d13eecbd50337d56a334b0795df1dabeca52c8123b8083136292506e351";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "usdt.tether-token.near";
const FEE_WALLET = "356aa2a2d7565c60150d8c690e60c68708ff35047d8ce9bb8bd78ca2c15a4d1b";
const NEAR = 10n ** 24n;
const REG = { total: "1250000000000000000000", available: "0" }; // "registered" storage balance

type Call = { contract: string; method: string; args: any; deposit: bigint; gas: bigint; waitUntil?: string };

function mockChain(opts: { native?: bigint; views?: (c: string, m: string, a: any) => unknown; existing?: string[]; failMethod?: string; afterSwap?: () => void } = {}) {
  const calls: Call[] = [];
  const transfers: { to: string; amount: bigint }[] = [];
  let native = opts.native ?? 10n * NEAR;
  const chain: Chain = {
    accountId: ME,
    nativeBalance: async () => native,
    view: (async (c: string, m: string, a: any) => (opts.views ? opts.views(c, m, a) : null)) as any,
    accountExists: async (id) => (opts.existing ?? []).includes(id),
    call: async (contract, method, args, o = {}) => {
      calls.push({ contract, method, args, deposit: o.depositYocto ?? 0n, gas: o.gas ?? 0n, waitUntil: o.waitUntil });
      if (opts.failMethod === method) return { txHash: "FAILED", ok: false, failure: "Smart contract panicked" };
      if (method === "ft_transfer_call") opts.afterSwap?.();
      return { txHash: `tx${calls.length}`, ok: true };
    },
    transferNative: async (to, amount) => {
      transfers.push({ to, amount });
      native -= amount;
      return { txHash: "txnative", ok: true };
    },
  };
  return { chain, calls, transfers };
}

// ---------------------------------------------------------------- send
test("send NEAR: exact amount, respects the reserve", async () => {
  const m = mockChain({ native: 5n * NEAR, existing: ["alice.near"] });
  const r = await executeSend({ kind: "send", token: "NEAR", amount: "1.5", toName: "Alice", toAddress: "alice.near" }, m.chain);
  assert.equal(r.ok, true);
  assert.deepEqual(m.transfers, [{ to: "alice.near", amount: 1_500_000_000_000_000_000_000_000n }]);
  const poor = mockChain({ native: 1n * NEAR + 100_000_000_000_000_000_000_000n, existing: ["alice.near"] }); // 1.1 NEAR, reserve 0.2
  await assert.rejects(() => executeSend({ kind: "send", token: "NEAR", amount: "1", toName: "Alice", toAddress: "alice.near" }, poor.chain), ExecError);
  assert.equal(poor.transfers.length, 0);
});

test("send NEAR: refuses a named account that does not exist, allows a new implicit account", async () => {
  const m = mockChain({ existing: [] });
  await assert.rejects(() => executeSend({ kind: "send", token: "NEAR", amount: "1", toName: "X", toAddress: "ghost.near" }, m.chain), /doesn't exist/);
  assert.equal(m.transfers.length, 0);
  await executeSend({ kind: "send", token: "NEAR", amount: "1", toName: "Y", toAddress: FEE_WALLET }, m.chain);
  assert.equal(m.transfers.length, 1);
});

test("send USDC to an unregistered receiver: registers first, then ft_transfer with 1 yocto", async () => {
  const m = mockChain({
    views: (c, mth, a) => (mth === "ft_balance_of" ? "5000000" : mth === "storage_balance_of" ? null : mth === "storage_balance_bounds" ? { min: REG.total, max: REG.total } : null),
  });
  const r = await executeSend({ kind: "send", token: "USDC", amount: "2", toName: "Treasury", toAddress: FEE_WALLET }, m.chain);
  assert.equal(r.ok, true);
  assert.deepEqual(m.calls.map((c) => c.method), ["storage_deposit", "ft_transfer"]);
  assert.deepEqual(m.calls[0].args, { account_id: FEE_WALLET, registration_only: true });
  assert.equal(m.calls[0].deposit, 1_250_000_000_000_000_000_000n);
  assert.equal(m.calls[1].contract, USDC);
  assert.deepEqual(m.calls[1].args, { receiver_id: FEE_WALLET, amount: "2000000" });
  assert.equal(m.calls[1].deposit, 1n);
});

test("send USDC to a registered receiver: no registration call; not enough balance: nothing is sent", async () => {
  const ok = mockChain({ views: (c, mth) => (mth === "ft_balance_of" ? "5000000" : REG) });
  await executeSend({ kind: "send", token: "USDC", amount: "2", toName: "T", toAddress: FEE_WALLET }, ok.chain);
  assert.deepEqual(ok.calls.map((c) => c.method), ["ft_transfer"]);
  const poor = mockChain({ views: (c, mth) => (mth === "ft_balance_of" ? "1000000" : REG) });
  await assert.rejects(() => executeSend({ kind: "send", token: "USDC", amount: "2", toName: "T", toAddress: FEE_WALLET }, poor.chain), /Not enough USDC/);
  assert.equal(poor.calls.length, 0);
});

test("a transaction that fails on-chain is reported, not hidden", async () => {
  const m = mockChain({ views: (c, mth) => (mth === "ft_balance_of" ? "5000000" : REG), failMethod: "ft_transfer" });
  await assert.rejects(() => executeSend({ kind: "send", token: "USDC", amount: "2", toName: "T", toAddress: FEE_WALLET }, m.chain), /failed on-chain: Smart contract panicked/);
});

// ---------------------------------------------------------------- swap
const route = (outUnits: string) => ({ route: { amount_in: "2000000", amount_out: outUnits, min_amount_out: outUnits, msg: "ROUTEMSG", signature: "SIG", tokens: ["wrap.near", USDC, USDT] }, feeOn: false });
const swap = (over: Record<string, string> = {}) => ({ kind: "swap" as const, from: "USDC", to: "NEAR", amount: "2", route: "Rhea SmartRouter", estOut: "0.49", estOutUnits: "490000000000000000000000", ...over });

test("swap USDC -> NEAR with nothing registered: registers, then ft_transfer_call with the signed route", async () => {
  let swapped = false;
  const m = mockChain({
    native: 5n * NEAR,
    afterSwap: () => (swapped = true),
    views: (c, mth) => {
      if (c === AGGREGATOR && mth === "query_user_tokens_registered") return [false, false, false];
      if (mth === "storage_balance_of") return null; // nobody registered anywhere
      if (mth === "ft_balance_of") return "5000000";
      return null;
    },
  });
  // native balance grows after the swap (the output is native NEAR)
  const chain = { ...m.chain, nativeBalance: async () => (swapped ? 5n * NEAR + 490_000_000_000_000_000_000_000n : 5n * NEAR) };
  const r = await executeSwapRhea(swap(), chain, { fetchRoute: async () => route("495000000000000000000000") });
  assert.equal(r.ok, true);
  const methods = m.calls.map((c) => c.method);
  assert.equal(methods.at(-1), "ft_transfer_call");
  assert.ok(methods.includes("tokens_storage_deposit"));
  const agg = m.calls.find((c) => c.method === "tokens_storage_deposit")!;
  assert.deepEqual(agg.args, { user: ME, tokens: ["wrap.near", USDC, USDT] });
  assert.equal(agg.deposit, 15_000_000_000_000_000_000_000n); // 3 tokens x 0.005 NEAR
  const last = m.calls.at(-1)!;
  assert.equal(last.contract, USDC);
  assert.equal(last.deposit, 1n);
  assert.equal(last.gas, 300_000_000_000_000n);
  assert.equal(last.waitUntil, "FINAL");
  assert.equal(last.args.receiver_id, AGGREGATOR);
  assert.equal(last.args.amount, "2000000");
  assert.deepEqual(JSON.parse(last.args.msg), { msg: "ROUTEMSG", signature: "SIG" }); // msg is a JSON STRING containing msg + signature
  assert.match(r.spoken, /received about 0\.49/);
});

test("swap NEAR -> USDC wraps first, then swaps from wrap.near, and reports what arrived", async () => {
  let swapped = false;
  const m = mockChain({
    native: 10n * NEAR,
    afterSwap: () => (swapped = true),
    views: (c, mth) => (c === AGGREGATOR && mth === "query_user_tokens_registered" ? [true, true, true] : mth === "storage_balance_of" ? REG : mth === "ft_balance_of" ? (swapped ? "4040000" : "0") : null),
  });
  const r = await executeSwapRhea(swap({ from: "NEAR", to: "USDC", amount: "1", estOutUnits: "4000000" }), m.chain, { fetchRoute: async () => route("4040000") });
  assert.deepEqual(m.calls.map((c) => c.method), ["near_deposit", "ft_transfer_call"]);
  const wrap = m.calls[0];
  assert.equal(wrap.contract, "wrap.near");
  assert.equal(wrap.deposit, NEAR); // exactly 1 NEAR wrapped
  assert.equal(m.calls[1].contract, "wrap.near");
  assert.equal(m.calls[1].args.amount, NEAR.toString());
  assert.equal(r.ok, true);
  assert.match(r.spoken, /received about 4\.04 USDC/);
});

test("swap: if the fee wallet is not registered on the route's tokens, it is registered too", async () => {
  config.feeRecipient = FEE_WALLET; config.feePerMille = 1;
  const m = mockChain({
    views: (c, mth, a) => (c === AGGREGATOR && mth === "query_user_tokens_registered" ? [true, true, true] : mth === "storage_balance_of" ? (a.account_id === FEE_WALLET ? null : REG) : mth === "ft_balance_of" ? "5000000" : null),
  });
  const withFee = { route: { ...route("495000000000000000000000").route }, feeOn: true };
  await executeSwapRhea(swap(), m.chain, { fetchRoute: async () => withFee }).catch(() => {});
  config.feeRecipient = "";
  const regs = m.calls.filter((c) => c.method === "storage_deposit");
  assert.equal(regs.length, 3); // one per token of the route
  assert.ok(regs.every((c) => c.args.account_id === FEE_WALLET));
  assert.equal(m.calls.at(-1)!.method, "ft_transfer_call");
});

test("swap: the fee wallet must ALSO be registered on the router contract, not only on the tokens (found by the dry run)", async () => {
  config.feeRecipient = FEE_WALLET; config.feePerMille = 1;
  const m = mockChain({
    views: (c, mth, a) =>
      c === AGGREGATOR && mth === "query_user_tokens_registered" ? (a.user === FEE_WALLET ? [false, true, false] : [true, true, true]) : mth === "storage_balance_of" ? REG : mth === "ft_balance_of" ? "5000000" : null,
  });
  await executeSwapRhea(swap(), m.chain, { fetchRoute: async () => ({ route: route("495000000000000000000000").route, feeOn: true }) }).catch(() => {});
  config.feeRecipient = "";
  const reg = m.calls.find((c) => c.method === "tokens_storage_deposit")!;
  assert.ok(reg, "the fee wallet registration on the router was not sent");
  assert.deepEqual(reg.args, { user: FEE_WALLET, tokens: ["wrap.near", USDT] }); // only the two it was missing
  assert.equal(reg.deposit, 10_000_000_000_000_000_000_000n); // 2 x 0.005 NEAR
  assert.equal(m.calls.at(-1)!.method, "ft_transfer_call");
});

test("swap stops with nothing half-done if an early step fails on-chain", async () => {
  const m = mockChain({
    failMethod: "tokens_storage_deposit",
    views: (c, mth) => (c === AGGREGATOR && mth === "query_user_tokens_registered" ? [false, false, false] : mth === "storage_balance_of" ? REG : mth === "ft_balance_of" ? "5000000" : null),
  });
  await assert.rejects(() => executeSwapRhea(swap(), m.chain, { fetchRoute: async () => route("495000000000000000000000") }), /Registering on the router failed/);
  assert.ok(!m.calls.some((c) => c.method === "ft_transfer_call"), "the swap must not be sent after a failed registration");
});

test("swap is cancelled when the fresh quote drifted beyond the limit; nothing is sent", async () => {
  const m = mockChain({ views: () => [true, true, true] });
  // approved ~0.49 NEAR, fresh route now 0.47 (-4%) with a 1% limit
  await assert.rejects(() => executeSwapRhea(swap(), m.chain, { fetchRoute: async () => route("470000000000000000000000") }), /price moved/);
  assert.equal(m.calls.length, 0);
});

test("swap checks it can afford every registration BEFORE sending any: no half-finished state", async () => {
  const m = mockChain({
    native: 260_000_000_000_000_000_000_000n, // 0.26 NEAR: less than the ~0.2725 needed (reserve 0.2 + margin 0.05 + registrations)
    views: (c, mth) => (c === AGGREGATOR && mth === "query_user_tokens_registered" ? [false, false, false] : mth === "storage_balance_of" ? null : mth === "ft_balance_of" ? "5000000" : null),
  });
  await assert.rejects(() => executeSwapRhea(swap(), m.chain, { fetchRoute: async () => route("495000000000000000000000") }), /Not enough NEAR for this swap/);
  assert.equal(m.calls.length, 0);
});

test("swap with already-registered accounts sends only the swap", async () => {
  let swapped = false;
  const m = mockChain({
    afterSwap: () => (swapped = true),
    views: (c, mth) => (c === AGGREGATOR && mth === "query_user_tokens_registered" ? [true, true, true] : mth === "storage_balance_of" ? REG : mth === "ft_balance_of" ? "5000000" : null),
  });
  const chain = { ...m.chain, nativeBalance: async () => (swapped ? 10n * NEAR + NEAR / 2n : 10n * NEAR) };
  const r = await executeSwapRhea(swap(), chain, { fetchRoute: async () => route("495000000000000000000000") });
  assert.deepEqual(m.calls.map((c) => c.method), ["ft_transfer_call"]);
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- proposals, approval rules
const price = async (s: string) => (s === "NEAR" ? 4 : 1);
let clock = Date.now();
function deps(chain?: Chain) {
  return {
    chain: () => chain ?? mockChain().chain,
    usdPrice: price,
    swapDeps: { fetchRoute: async () => route("495000000000000000000000") },
    now: () => clock,
    compare: (async () => ({
      routes: [{ source: "Rhea SmartRouter", amountOut: "0.49", amountOutUnits: 490000000000000000000000n, orbiFeePct: 0.1 }, { source: "NEAR Intents", amountOut: "0.488", amountOutUnits: 488000000000000000000000n, orbiFeePct: 0 }],
      best: undefined, errors: [],
    })) as any,
  };
}
beforeEach(() => {
  resetActionsForTests();
  clock = Date.now();
  config.agentAccount = ME;
  removeContact("Treasury");
  addContact("Treasury", FEE_WALLET); // fresh contact, never paid, for every test
  config.executionMode = "rehearsal";
  config.network = "mainnet";
  config.maxActionUsd = 10; config.maxDailyUsd = 25; config.maxNewAddressUsd = 5;
});
test("contacts: names map to addresses; bad input is rejected", () => {
  assert.throws(() => addContact("Mom", "not an address!"), /NEAR account/);
  assert.throws(() => addContact("Treasury", "someone.near"), /already exists/);
  assert.throws(() => addContact("Other", FEE_WALLET), /already saved/);
  assert.throws(() => addContact("Me", ME), /own wallet/);
  assert.throws(() => addContact("", "bob.near"), /Names are/);
  assert.equal(listContacts().length >= 1, true);
});

test("send proposals: addresses by voice, unknown names and limits are refused with a friendly message", async () => {
  const p = newPolicyState();
  await assert.rejects(() => proposeSend("s1", { token: "NEAR", amount: 1, to_name: "alice.near" }, p, deps()), /addresses by voice/);
  await assert.rejects(() => proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Nobody" }, p, deps()), /don't have a contact called Nobody/);
  await assert.rejects(() => proposeSend("s1", { token: "NEAR", amount: 0, to_name: "Treasury" }, p, deps()), /more than zero/);
  await assert.rejects(() => proposeSend("s1", { token: "DOGE", amount: 1, to_name: "Treasury" }, p, deps()), /can send/);
  await assert.rejects(() => proposeSend("s1", { token: "NEAR", amount: 1.5, to_name: "Treasury" }, p, deps()), /first payment/); // $6 > $5 first-payment cap
  await assert.rejects(() => proposeSend("s1", { token: "NEAR", amount: 2.6, to_name: "Treasury" }, p, deps()), /per-action limit/); // $10.40 > $10
});

test("a card shows the full address and warns about a first payment; nothing is signed in rehearsal", async () => {
  const p = newPolicyState();
  const card = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "treasury" }, p, deps());
  assert.equal(card.address, FEE_WALLET);
  assert.match(card.warnings.join(" "), /First payment/);
  assert.match(card.warnings.join(" "), /Rehearsal/);
  assert.equal(card.mode, "rehearsal");
  const m = mockChain();
  const out = await approve("s1", card.id, card.hash, p, deps(m.chain));
  assert.equal(out.simulated, true);
  assert.equal(m.calls.length + m.transfers.length, 0, "rehearsal must never touch the chain");
  assert.equal(p.spentUsd, 0, "rehearsal must not use up the daily limit");
});

test("approval needs the right session, the right hash, and a card that is still open", async () => {
  const p = newPolicyState();
  const card = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, deps());
  await assert.rejects(() => approve("other-session", card.id, card.hash, p, deps()), /can't find that card/);
  await assert.rejects(() => approve("s1", card.id, "0".repeat(64), p, deps()), /doesn't match/);
  await assert.rejects(() => approve("s1", "no-such-id", card.hash, p, deps()), /can't find/);
  await approve("s1", card.id, card.hash, p, deps());
  await assert.rejects(() => approve("s1", card.id, card.hash, p, deps()), /already done/); // single use
});

test("a double tap cannot run an action twice", async () => {
  config.executionMode = "live";
  const p = newPolicyState();
  const m = mockChain({ existing: [FEE_WALLET] });
  const d = deps(m.chain);
  const card = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d);
  const results = await Promise.allSettled([approve("s1", card.id, card.hash, p, d), approve("s1", card.id, card.hash, p, d)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(m.transfers.length, 1);
});

test("an expired card cannot be approved", async () => {
  const p = newPolicyState();
  const card = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, deps());
  clock += (config.pendingTtlSec + 1) * 1000;
  await assert.rejects(() => approve("s1", card.id, card.hash, p, deps()), /expired/);
});

test("a new proposal replaces the open one; the old card is dead", async () => {
  const p = newPolicyState();
  const a = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, deps());
  const b = await proposeSwap("s1", { from_token: "USDC", to_token: "NEAR", amount: 2 }, p, deps());
  assert.equal(openCard("s1")?.id, b.id);
  await assert.rejects(() => approve("s1", a.id, a.hash, p, deps()), /no longer open/);
});

test("the daily limit is checked again at approval time", async () => {
  const p = newPolicyState();
  const card = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, deps()); // $4
  p.spentUsd = 24; // something else used up the day in the meantime
  await assert.rejects(() => approve("s1", card.id, card.hash, p, deps()), /daily limit/);
});

test("live mode: approval really calls the chain, records spend and counts the payment to the contact", async () => {
  config.executionMode = "live";
  const p = newPolicyState();
  const m = mockChain({ existing: [FEE_WALLET] });
  const d = deps(m.chain);
  const card = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d);
  assert.equal(card.mode, "live");
  const out = await approve("s1", card.id, card.hash, p, d);
  assert.equal(out.simulated, false);
  assert.equal(m.transfers.length, 1);
  assert.equal(p.spentUsd, 4);
  assert.equal(listContacts().find((c) => c.name === "Treasury")!.sends, 1);
  // after one payment the first-payment cap no longer applies
  const second = await proposeSend("s1", { token: "NEAR", amount: 2, to_name: "Treasury" }, p, d); // $8 > $5 would have been refused before
  assert.ok(second.id);
});

test("live mode proposal is refused when the wallet cannot afford it", async () => {
  config.executionMode = "live";
  const m = mockChain({ native: NEAR / 2n });
  await assert.rejects(() => proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, newPolicyState(), deps(m.chain)), /don't have enough NEAR/);
});

test("execution turned off: nothing can be proposed", async () => {
  config.executionMode = "off";
  await assert.rejects(() => proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, newPolicyState(), deps()), /turned off/);
  await assert.rejects(() => proposeSwap("s1", { from_token: "USDC", to_token: "NEAR", amount: 2 }, newPolicyState(), deps()), /turned off/);
});

test("swap card: executable route is Rhea, mentions a better Intents quote honestly, and rejecting closes it", async () => {
  const p = newPolicyState();
  const card = await proposeSwap("s1", { from_token: "USDC", to_token: "NEAR", amount: 2 }, p, deps());
  assert.match(card.title, /Swap 2 USDC for about 0.49 NEAR/);
  assert.equal(card.usd, 2);
  assert.equal(reject("s1", card.id), true);
  assert.equal(openCard("s1"), null);
  await assert.rejects(() => approve("s1", card.id, card.hash, p, deps()), /no longer open/);
  await assert.rejects(() => proposeSwap("s1", { from_token: "USDC", to_token: "USDC", amount: 2 }, p, deps()), /same token/);
  await assert.rejects(() => proposeSwap("s1", { from_token: "USDC", to_token: "NEAR", amount: 50 }, p, deps()), /per-action limit/);
});

test("swaps are refused on the test network (they only exist on mainnet)", async () => {
  config.executionMode = "live"; config.network = "testnet";
  await assert.rejects(() => proposeSwap("s1", { from_token: "USDC", to_token: "NEAR", amount: 2 }, newPolicyState(), deps()), /only exist on mainnet/);
  config.network = "mainnet";
});

test("the send card is honest about network fees", async () => {
  const card = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, newPolicyState(), deps());
  assert.match(card.lines.join(" "), /new account/);
  assert.doesNotMatch(card.lines.join(" "), /fraction of a cent/);
});

test("saving a contact checks the account on the network: typos are refused, unused 64-hex accounts and outages are allowed with a note", async () => {
  const { checkNewContact } = await import("../src/contacts.ts");
  const real = async () => true, missing = async () => false, down = async () => { throw new Error("rpc down"); }, slow = () => new Promise<boolean>(() => {});
  assert.deepEqual(await checkNewContact("eric.near", real), { ok: true });
  const typo = await checkNewContact("eric.nera", missing);
  assert.equal(typo.ok, false);
  assert.match((typo as any).error, /can't find eric\.nera/);
  const fresh = await checkNewContact("a".repeat(64), missing);
  assert.equal(fresh.ok, true);
  assert.match((fresh as any).notice, /first payment will create/);
  const offline = await checkNewContact("eric.near", down);
  assert.equal(offline.ok, true);
  assert.match((offline as any).notice, /couldn't check/);
  assert.equal((await checkNewContact("eric.near", slow, 30)).ok, true); // a hung node must not hang the form
  assert.equal((await checkNewContact("not an address!", real)).ok, false);
  assert.equal((await checkNewContact("ERIC.NEAR", real)).ok, true); // case is normalised
});

test("reading a contact's balance needs a saved contact name, and the result never contains an address", async () => {
  const { runTool } = await import("../src/tools.ts");
  const out = JSON.parse(await runTool("get_balances", JSON.stringify({ contact: "Nobody Here" })));
  assert.match(out.user_error, /don't have a contact called Nobody Here/);
  assert.equal(JSON.stringify(out).includes(FEE_WALLET), false);
});

// ---------------------------------------------------------------- shared-demo guardrails
test("live actions run one at a time: a second approval waits, its card stays open, then it works", async () => {
  config.executionMode = "live";
  const p = newPolicyState();
  const m = mockChain({ existing: [FEE_WALLET] });
  const slow = m.chain.transferNative;
  m.chain.transferNative = async (to, amount) => {
    await new Promise((r) => setTimeout(r, 40));
    return slow(to, amount);
  };
  const d = deps(m.chain);
  const c1 = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d);
  const c2 = await proposeSend("s2", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d);
  const [r1, r2] = await Promise.allSettled([approve("s1", c1.id, c1.hash, p, d), approve("s2", c2.id, c2.hash, p, d)]);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r2.status, "rejected");
  assert.match(String((r2 as PromiseRejectedResult).reason.message), /Another approval is being processed/);
  assert.equal(m.transfers.length, 1, "only one transaction went out");
  const again = await approve("s2", c2.id, c2.hash, p, d); // the second card was never consumed
  assert.equal(again.ok, true);
  assert.equal(m.transfers.length, 2);
});

test("the lock is released after a failure", async () => {
  config.executionMode = "live";
  const p = newPolicyState();
  const bad = mockChain({ existing: [] }); // Treasury account missing as far as this chain knows, but implicit ids are allowed
  bad.chain.transferNative = async () => {
    throw new Error("network down");
  };
  const d = deps(bad.chain);
  const c1 = await proposeSend("s1", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d);
  await assert.rejects(() => approve("s1", c1.id, c1.hash, p, d));
  const good = mockChain({ existing: [FEE_WALLET] });
  const d2 = deps(good.chain);
  const c2 = await proposeSend("s2", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d2);
  assert.equal((await approve("s2", c2.id, c2.hash, p, d2)).ok, true);
});

test("a daily cap on the number of real actions stops further ones", async () => {
  config.executionMode = "live";
  config.maxLiveActionsPerDay = 2;
  try {
    const p = newPolicyState();
    const m = mockChain({ existing: [FEE_WALLET] });
    const d = deps(m.chain);
    for (let i = 0; i < 2; i++) {
      const c = await proposeSend(`s${i}`, { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d);
      await approve(`s${i}`, c.id, c.hash, p, d);
    }
    await assert.rejects(() => proposeSend("s9", { token: "NEAR", amount: 1, to_name: "Treasury" }, p, d), /limit of 2 real actions/);
    assert.equal(m.transfers.length, 2);
  } finally {
    config.maxLiveActionsPerDay = 0;
  }
});
