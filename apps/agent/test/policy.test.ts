import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAction, newPolicyState, recordSpend } from "../src/policy.ts";
import { toUnits, fromUnits } from "../src/tokens.ts";
import { applyFee } from "../src/quotes.ts";

const limits = { maxActionUsd: 10, maxDailyUsd: 25 };

test("allows an action within limits", () => {
  const s = newPolicyState();
  assert.equal(checkAction(5, s, limits).allowed, true);
});

test("refuses an action above the per-action limit", () => {
  const s = newPolicyState();
  const v = checkAction(10.01, s, limits);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /per-action/);
});

test("refuses once the daily limit would be exceeded", () => {
  const s = newPolicyState();
  recordSpend(9, s);
  recordSpend(9, s);
  assert.equal(checkAction(8, s, limits).allowed, false); // 18 + 8 > 25
  assert.equal(checkAction(7, s, limits).allowed, true); // 18 + 7 = 25
});

test("refuses unknown or invalid USD values", () => {
  const s = newPolicyState();
  assert.equal(checkAction(NaN, s, limits).allowed, false);
  assert.equal(checkAction(0, s, limits).allowed, false);
  assert.equal(checkAction(-3, s, limits).allowed, false);
});

test("daily total resets on a new day", () => {
  const s = newPolicyState(new Date("2026-11-04T10:00:00Z"));
  recordSpend(24, s);
  assert.equal(checkAction(5, s, limits, new Date("2026-11-04T23:00:00Z")).allowed, false);
  assert.equal(checkAction(5, s, limits, new Date("2026-11-05T01:00:00Z")).allowed, true);
});

test("Orbi fee is deducted exactly and rounds down", () => {
  assert.equal(applyFee(4_047_800n, 1), 4_043_752n); // 0.1% of 4.0478 USDC, rounded down
  assert.equal(applyFee(1000n, 0), 1000n);
  assert.equal(applyFee(999n, 1), 998n);
});

test("unit conversion has no floating point error", () => {
  assert.equal(toUnits("2.5", 24), "2500000000000000000000000");
  assert.equal(toUnits("0.1", 6), "100000");
  assert.equal(fromUnits("4027332", 6), "4.027332");
  assert.throws(() => toUnits("1.1234567", 6));
  assert.throws(() => toUnits("abc", 6));
});
