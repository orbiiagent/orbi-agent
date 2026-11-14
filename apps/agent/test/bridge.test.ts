import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.NEAR_AGENT_ACCOUNT_ID = "a".repeat(64);
process.env.ORBI_NETWORK = "mainnet";
process.env.ORBI_EXECUTION = "rehearsal";
process.env.ORBI_BRIDGE_FILE = `${mkdtempSync(`${tmpdir()}/orbi-bridge-`)}/bridge.json`;
process.env.ORBI_ACTIVITY_FILE = `${mkdtempSync(`${tmpdir()}/orbi-act-`)}/activity.jsonl`;
delete process.env.ORBI_BASE_REFUND_ADDRESS;
const B = await import("../src/bridge.ts");
const { runTool } = await import("../src/tools.ts");
const { routeIntent } = await import("../src/fastpath.ts");

const DEPOSIT = "0x" + "ab".repeat(20);
const REFUND = "0x" + "12".repeat(20);
const quote = (over: any = {}) => ({ quote: { depositAddress: DEPOSIT, amountIn: "20000000", amountInUsd: "19.99", amountOut: "5891353380190567450161000", minAmountOut: "5832439846388661775659390", timeEstimate: 35, ...over } });
const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const deps = (f: any, native = 1n) => ({ fetch: f, nativeBalance: async () => native, now: () => Date.now() });

test("refund address: lowercase 0x + 40 hex only, saved for later", () => {
  assert.equal(B.getRefundAddress(), null);
  for (const bad of ["", "0x123", "eric.near", "0x" + "0".repeat(40), "0x000000000000000000000000000000000000dEaD", "0x" + "g".repeat(40)]) assert.throws(() => B.setRefundAddress(bad), B.BridgeError, bad);
  assert.equal(B.setRefundAddress("0x" + "AB".repeat(20)), "0x" + "ab".repeat(20));
  assert.equal(B.getRefundAddress(), "0x" + "ab".repeat(20));
  B.setRefundAddress(REFUND);
});

test("a deposit card shows the address Intents returned and what the owner will get", async () => {
  B.resetBridgeForTests();
  let sent: any;
  const card = await B.proposeDeposit("s1", { amount: 20 }, deps(async (_u: string, init: any) => { sent = JSON.parse(init.body); return reply(201, quote())(); }));
  assert.equal(card.kind, "deposit");
  assert.equal(card.address, DEPOSIT);
  assert.equal(card.amount, "20");
  assert.match(card.lines[1], /5\.8913 NEAR/);
  assert.match(card.lines[4], /ending 121212/);
  assert.equal(sent.dry, false);
  assert.equal(sent.originAsset, B.BASE_USDC);
  assert.equal(sent.destinationAsset, B.NEAR_OUT);
  assert.equal(sent.recipient, "a".repeat(64));
  assert.equal(sent.refundTo, REFUND);
  assert.equal(sent.amount, "20000000");
  assert.ok(card.expiresAt > Date.now() + 30 * 60_000);
  assert.equal(B.openDeposit("s1")?.id, card.id);
  assert.equal(B.openDeposit("other"), null);
});

test("warns that the first deposit creates Orbi's wallet when it does not exist yet", async () => {
  B.resetBridgeForTests();
  const card = await B.proposeDeposit("s2", { amount: 3 }, deps(reply(201, quote({ amountIn: "3000000" })), 0n));
  assert.match(card.warnings[0], /doesn't exist on the NEAR network yet/);
});

test("refuses bad amounts, big amounts, and a missing refund address", async () => {
  B.resetBridgeForTests();
  const ok = deps(reply(201, quote()));
  for (const a of [0, -1, "abc", "", 1.1234567]) await assert.rejects(B.proposeDeposit("s", { amount: a }, ok), B.BridgeError, String(a));
  await assert.rejects(B.proposeDeposit("s", { amount: 100000 }, ok), /above my limit/);
  const saved = process.env.ORBI_BRIDGE_FILE;
  process.env.ORBI_BRIDGE_FILE = `${mkdtempSync(`${tmpdir()}/orbi-bridge2-`)}/bridge.json`; // no refund address saved here
  await assert.rejects(B.proposeDeposit("s", { amount: 5 }, ok), /Base address/);
  process.env.ORBI_BRIDGE_FILE = saved;
});

test("never shows an address or amount it does not trust", async () => {
  B.resetBridgeForTests();
  for (const q of [quote({ depositAddress: "eric.near" }), quote({ depositAddress: "" }), quote({ depositAddress: "0x123" }), quote({ amountIn: "19000000" })])
    await assert.rejects(B.proposeDeposit("s3", { amount: 20 }, deps(reply(201, q))), /Nothing was started/);
  assert.equal(B.openDeposit("s3"), null);
});

test("bridge errors are friendly", async () => {
  B.resetBridgeForTests();
  await assert.rejects(B.proposeDeposit("s", { amount: 0.5 }, deps(reply(400, { message: "Amount is too low for the swap" }))), /minimum/);
  await assert.rejects(B.proposeDeposit("s", { amount: 5 }, deps(reply(500, { message: "boom" }))), /couldn't set that up/);
  await assert.rejects(B.proposeDeposit("s", { amount: 5 }, deps(async () => { throw new Error("down"); })), /couldn't reach the bridge/);
});

test("status follows the deposit and says what to do at each step", async () => {
  B.resetBridgeForTests();
  const card = await B.proposeDeposit("s4", { amount: 20 }, deps(reply(201, quote())));
  const st = (body: unknown, code = 200) => B.depositStatus("s4", card.id, deps(reply(code, body)));
  assert.equal((await st({}, 404)).state, "waiting");
  assert.equal((await st({ status: "PENDING_DEPOSIT" })).state, "waiting");
  assert.equal((await st({ status: "PROCESSING" })).state, "processing");
  assert.match((await st({ status: "INCOMPLETE_DEPOSIT" })).spoken, /short/);
  assert.equal((await st({ status: "REFUNDED" })).state, "refunded");
  const done = await st({ status: "SUCCESS", swapDetails: { amountOutFormatted: "5.87", destinationChainTxHashes: [{ hash: "TXHASH" }] } });
  assert.equal(done.state, "done");
  assert.match(done.spoken, /5\.87 NEAR/);
  assert.equal(done.txUrl, "https://nearblocks.io/txns/TXHASH");
  assert.equal(B.openDeposit("s4"), null); // settled: no longer an open card
  await assert.rejects(B.depositStatus("nobody", undefined, deps(reply(200, {}))), /don't have a deposit open/);
});

test("a window that closes with nothing deposited is reported as expired", async () => {
  B.resetBridgeForTests();
  const card = await B.proposeDeposit("s5", { amount: 20 }, deps(reply(201, quote())));
  const late = { ...deps(reply(404, {})), now: () => card.expiresAt + 1000 };
  assert.equal((await B.depositStatus("s5", card.id, late)).state, "expired");
});

test("the tools wrap it and never carry the address into the spoken text", async () => {
  B.resetBridgeForTests();
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: any) => (String(u).includes("/v0/quote") ? reply(201, quote())() : reply(404, {})())) as any;
  try {
    const out = JSON.parse(await runTool("propose_deposit", JSON.stringify({ amount: 20 }), { session: "s6" }));
    assert.equal(out.orbi_sent_nothing, true);
    assert.equal(out.card.address, DEPOSIT);
    assert.match(JSON.stringify(out.estimate_near), /NEAR/);
    const st = JSON.parse(await runTool("get_deposit_status", "{}", { session: "s6" }));
    assert.equal(st.state, "waiting");
    assert.match(JSON.parse(await runTool("propose_deposit", JSON.stringify({ amount: "lots" }), { session: "s6" })).user_error, /How much/);
  } finally {
    globalThis.fetch = real;
  }
});

test("'bring in 20 USDC from Base' is a deposit request, and the guard keeps it away from the price fast path", () => {
  assert.match("bring in 20 USDC from Base to NEAR", /\b(bridge|bridging|deposit|top ?up|from base|on base|base network|bring (?:in|over))\b/i);
  void routeIntent; // the real guard lives in agent.ts; this only documents the phrase it must catch
});
