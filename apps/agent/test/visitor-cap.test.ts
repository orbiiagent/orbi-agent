import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "orbi-cap-"));
process.env.ORBI_ACTIVITY_FILE = join(dir, "activity.jsonl");
const { config } = await import("../src/config.ts");
const { liveActionsToday, visitorCapReason } = await import("../src/actions.ts");
const { bindSession } = await import("../src/owner.ts");

const A = "a".repeat(32);
const B = "b".repeat(32);
const today = new Date().toISOString();
const row = (o: object) => ({ event: "done", ok: true, simulated: false, at: today, ...o });
const file = join(dir, "log.jsonl");
const write = (rows: object[]) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

beforeEach(() => {
  process.env.ORBI_MULTIUSER = "on";
  process.env.ORBI_DATA_DIR = dir;
  config.executionMode = "live";
  config.maxLiveActionsPerVisitor = 2;
  bindSession("sa", A);
  bindSession("sb", B);
});
afterEach(() => {
  delete process.env.ORBI_MULTIUSER;
  delete process.env.ORBI_DATA_DIR;
  config.executionMode = "rehearsal";
  config.maxLiveActionsPerVisitor = 0;
});

test("counts only this visitor's real, finished actions from today", () => {
  const old = new Date(Date.now() - 3 * 86400_000).toISOString();
  write([row({ owner: A }), row({ owner: A }), row({ owner: B }), row({ owner: A, simulated: true }), row({ owner: A, ok: false }), row({ owner: A, at: old }), { event: "approved", owner: A, at: today }]);
  assert.equal(liveActionsToday(A, file), 2);
  assert.equal(liveActionsToday(B, file), 1);
  assert.equal(liveActionsToday("c".repeat(32), file), 0);
});

test("a visitor at the cap is told so, others and fresh visitors are not", () => {
  write([row({ owner: A }), row({ owner: A }), row({ owner: B })]);
  assert.match(String(visitorCapReason("sa", file)), /used your 2 real actions/);
  assert.equal(visitorCapReason("sb", file), null);
});

test("no cap when it is off, when not hosted, or when not live", () => {
  write([row({ owner: A }), row({ owner: A }), row({ owner: A })]);
  config.maxLiveActionsPerVisitor = 0;
  assert.equal(visitorCapReason("sa", file), null);
  config.maxLiveActionsPerVisitor = 2;
  config.executionMode = "rehearsal";
  assert.equal(visitorCapReason("sa", file), null);
  config.executionMode = "live";
  delete process.env.ORBI_MULTIUSER;
  assert.equal(visitorCapReason("sa", file), null);
});

test("an unknown visitor is not let through", () => {
  write([]);
  assert.match(String(visitorCapReason("nobody", file)), /can't tell who you are/);
});

test("a damaged log line is skipped, a missing log means zero", () => {
  writeFileSync(file, `not json "done"\n${JSON.stringify(row({ owner: A }))}\n`);
  assert.equal(liveActionsToday(A, file), 1);
  assert.equal(liveActionsToday(A, join(dir, "missing.jsonl")), 0);
});

// ---------------------------------------------------------------- per-connection cap and the Treasury-send limit
const { bindSessionIp, hashIp } = await import("../src/owner.ts");
const { liveActionsTodayByIp, liveSendsToday, sendCapReason } = await import("../src/actions.ts");

test("the per-connection cap counts by hashed address, so cleared cookies don't reset it", () => {
  const h = hashIp("203.0.113.7");
  const other = hashIp("198.51.100.9");
  assert.notEqual(h, other);
  assert.ok(!h.includes("203"), "the hash does not contain the address");
  config.maxLiveActionsPerVisitor = 0;
  config.maxLiveActionsPerIp = 2;
  try {
    bindSessionIp("sa", "203.0.113.7");
    bindSessionIp("sb", "198.51.100.9");
    write([row({ owner: "x".repeat(32), ipHash: h }), row({ owner: "y".repeat(32), ipHash: h }), row({ ipHash: other })]); // two different cookies, same connection
    assert.equal(liveActionsTodayByIp(h, file), 2);
    assert.match(String(visitorCapReason("sa", file)), /This connection has used its 2 real actions/);
    assert.equal(visitorCapReason("sb", file), null);
    assert.match(String(visitorCapReason("nobody-ip", file)), /can't tell where you are connecting from|can't tell who you are/);
  } finally {
    config.maxLiveActionsPerIp = 0;
  }
});

test("sends to Treasury have their own daily limit, and swaps are not affected", () => {
  const prop = (id: string, kind: string, usd: number) => ({ event: "proposed", id, action: { kind }, usd, at: today });
  write([
    prop("1", "send", 0.5), row({ id: "1" }),
    prop("2", "send", 0.5), row({ id: "2" }),
    prop("3", "swap", 0.5), row({ id: "3" }),
    prop("4", "send", 0.5), { event: "done", id: "4", ok: true, simulated: true, at: today }, // rehearsal: not counted
  ]);
  assert.deepEqual(liveSendsToday(file), { count: 2, usd: 1 });
  config.maxLiveSendsPerDay = 2;
  try {
    assert.match(String(sendCapReason(file)), /limit/);
    config.maxLiveSendsPerDay = 3;
    assert.equal(sendCapReason(file), null);
    config.maxLiveSendUsdPerDay = 1;
    assert.match(String(sendCapReason(file)), /limit/); // the dollar limit alone is enough
    config.maxLiveSendUsdPerDay = 0;
    config.executionMode = "rehearsal";
    config.maxLiveSendsPerDay = 1;
    assert.equal(sendCapReason(file), null); // only applies to real actions
  } finally {
    config.maxLiveSendsPerDay = 0;
    config.maxLiveSendUsdPerDay = 0;
  }
});
