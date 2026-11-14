import { test } from "node:test";
import assert from "node:assert/strict";
const { explainFailure, explainStatus } = await import("../src/diagnose.ts");
const ME = "c6473d13eecbd50337d56a334b0795df1dabeca52c8123b8083136292506e351";

test("failures are put in plain words, unknown ones are kept short and visible", () => {
  assert.match(explainFailure('{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Exceeded the prepaid gas."}}}}'), /ran out of gas/);
  assert.match(explainFailure('{"ActionError":{"kind":"LackBalanceForState"}}'), /enough NEAR to cover the storage/);
  assert.match(explainFailure('{"ActionError":{"kind":{"AccountDoesNotExist":{"account_id":"x"}}}}'), /doesn't exist yet/);
  assert.match(explainFailure('{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: The account abc is not registered"}}}}'), /isn't registered/);
  assert.match(explainFailure('{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: E22: something odd"}}}}'), /The contract refused it: E22: something odd/);
  assert.equal(explainFailure(undefined), "unknown error");
  assert.ok(explainFailure("x".repeat(500)).length <= 160);
});

test("a swap paid out as wNEAR is explained from the transaction record", () => {
  const status = { transaction_outcome: { outcome: { status: { SuccessReceiptId: "a" }, executor_id: ME, logs: [] } }, receipts_outcome: [
    { outcome: { status: { SuccessValue: "" }, executor_id: "aggregatedex.near", logs: [] } },
    { outcome: { status: { SuccessValue: "" }, executor_id: "wrap.near", logs: [`Transfer 540699830899803095701471 from aggregatedex.near to ${ME}`] } },
  ] };
  assert.match(explainStatus(status, ME)!, /paid you 0\.5406 wNEAR .* instead of plain NEAR/);
});

test("a transaction record with a failed step is explained by that failure; a clean one gives no reason", () => {
  const bad = { transaction_outcome: { outcome: { status: { SuccessReceiptId: "a" }, executor_id: ME, logs: [] } }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Exceeded the prepaid gas." } } } } }, executor_id: "x", logs: [] } }] };
  assert.match(explainStatus(bad, ME)!, /ran out of gas/);
  const clean = { transaction_outcome: { outcome: { status: { SuccessValue: "" }, executor_id: ME, logs: [] } }, receipts_outcome: [] };
  assert.equal(explainStatus(clean, ME), null);
  assert.equal(explainStatus(undefined, ME), null);
});
