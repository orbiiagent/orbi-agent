import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { entriesFromLog, recentTransactions } from "../src/history.ts";
import { routeIntent, phrase, ago } from "../src/fastpath.ts";

const L = (o: object) => JSON.stringify(o);
const sendProposed = (id: string, at: string, amount = "1", mode = "live") => L({ at, event: "proposed", id, action: { kind: "send", token: "NEAR", amount, toName: "Treasury" }, mode });
const file = () => `${mkdtempSync(`${tmpdir()}/orbi-hist-`)}/activity.jsonl`;

test("groups the log by action and derives a status", () => {
  const e = entriesFromLog([
    { at: "2026-01-01T10:00:00Z", event: "proposed", id: "a", action: { kind: "send", token: "NEAR", amount: "1", toName: "Treasury" }, mode: "live" },
    { at: "2026-01-01T10:00:20Z", event: "approved", id: "a", mode: "live" },
    { at: "2026-01-01T10:00:30Z", event: "done", id: "a", ok: true, simulated: false, txs: ["HASH1"] },
    { at: "2026-01-01T11:00:00Z", event: "proposed", id: "b", action: { kind: "swap", from: "NEAR", to: "USDC", amount: "2", estOut: "7.1" }, mode: "live" },
    { at: "2026-01-01T11:00:10Z", event: "rejected", id: "b" },
    { at: "2026-01-01T12:00:00Z", event: "proposed", id: "c", action: { kind: "send", token: "NEAR", amount: "3", toName: "Treasury" }, mode: "live" },
  ]);
  assert.deepEqual(e.map((x) => [x.id, x.status]), [["a", "completed"], ["b", "declined"], ["c", "never_approved"]]);
  assert.equal(e[0].txs[0], "HASH1");
  assert.equal(e[1].toToken, "USDC");
});

test("the last transaction is the last one that actually ran, and a newer unapproved request is mentioned", async () => {
  const f = file();
  writeFileSync(f, [
    sendProposed("a", "2026-01-01T10:00:00Z", "1"), L({ at: "2026-01-01T10:00:20Z", event: "approved", id: "a" }), L({ at: "2026-01-01T10:00:30Z", event: "done", id: "a", ok: true, simulated: true, txs: [] }),
    sendProposed("b", "2026-01-02T10:00:00Z", "9"), L({ at: "2026-01-02T10:00:05Z", event: "rejected", id: "b" }),
  ].join("\n") + "\n");
  const r = await recentTransactions(f, 1, false);
  assert.equal(r.count, 1);
  assert.equal(r.transactions[0].id, "a");
  assert.equal(r.last_unexecuted?.status, "declined");
});

test("no log yet means nothing has happened", async () => {
  const r = await recentTransactions(`${tmpdir()}/orbi-does-not-exist-${Date.now()}.jsonl`, 1, false);
  assert.equal(r.count, 0);
  assert.match(phrase("get_last_transaction", {}, JSON.stringify(r), (o) => o[0]) ?? "", /haven't sent or swapped anything/);
});

test("routes history questions, not instructions", () => {
  for (const t of ["What was my last transaction?", "did it go through?", "Show me my recent activity", "what did you just do", "Did my swap go through?", "what's the latest transfer"])
    assert.equal(routeIntent(t)?.tool, "get_last_transaction", t);
  assert.deepEqual(routeIntent("show my last 3 transactions")?.args, { count: 3 });
  assert.deepEqual(routeIntent("what was my last transaction")?.args, { count: 1 });
  for (const t of ["Send 1 NEAR to Treasury", "swap my last 2 NEAR to USDC", "what's the price of NEAR", "send the same as my last transaction to bob"])
    assert.notEqual(routeIntent(t)?.tool, "get_last_transaction", t);
});

test("says it plainly: confirmed, rehearsal, failed", () => {
  const base = { id: "a", at: "2026-01-01T10:00:00Z", finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(), kind: "send", token: "NEAR", amount: "1", to: "Treasury", txs: ["H"], explorer: [] };
  const say = (e: object, extra = {}) => phrase("get_last_transaction", {}, JSON.stringify({ transactions: [{ ...base, ...e }], ...extra }), (o) => o[0]) ?? "";
  assert.match(say({ mode: "live", status: "completed", simulated: false, onchain: "confirmed" }), /send of 1 NEAR to Treasury, 5 minutes ago\. And it's confirmed on the network\./);
  assert.match(say({ mode: "live", status: "completed", simulated: false, onchain: "unknown" }), /couldn't double-check/);
  assert.match(say({ mode: "live", status: "completed", simulated: false, onchain: "failed" }), /network says it failed/);
  assert.match(say({ mode: "rehearsal", status: "completed", simulated: true }), /just a rehearsal though, so nothing actually moved/);
  assert.match(say({ mode: "live", status: "failed", simulated: false }), /didn't go through/);
  assert.match(say({ mode: "live", status: "completed", simulated: false, onchain: "confirmed" }, { last_unexecuted: { status: "declined", at: "x" } }), /never got approved/);
  assert.match(say({ kind: "swap", token: "NEAR", toToken: "USDC", estOut: "3.51", amount: "1", mode: "live", status: "completed", simulated: false, onchain: "confirmed" }), /swap of 1 NEAR for about 3.51 USDC/);
});

test("time wording", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  assert.equal(ago("2026-01-01T23:59:40Z", now), "just now");
  assert.equal(ago("2026-01-01T23:55:00Z", now), "5 minutes ago");
  assert.equal(ago("2026-01-01T21:00:00Z", now), "3 hours ago");
  assert.equal(ago("2025-12-31T00:00:00Z", now), "2 days ago");
});
