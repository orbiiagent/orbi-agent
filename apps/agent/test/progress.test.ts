import { test } from "node:test";
import assert from "node:assert/strict";
import { startRun, stepStart, endRun, getRun } from "../src/progress.ts";

test("steps are recorded in order and the earlier one is finished when the next starts", () => {
  startRun("a1", "s1");
  stepStart("a1", "Checking the balance");
  stepStart("a1", "Sending 1 NEAR to Treasury");
  const r = getRun("s1", "a1")!;
  assert.equal(r.status, "running");
  assert.deepEqual(r.steps.map((s) => s.state), ["done", "doing"]);
  endRun("a1", true);
  const d = getRun("s1", "a1")!;
  assert.equal(d.status, "done");
  assert.deepEqual(d.steps.map((s) => s.state), ["done", "done"]);
});

test("a failed run marks the open step failed", () => {
  startRun("a2", "s1");
  stepStart("a2", "The swap");
  endRun("a2", false);
  const r = getRun("s1", "a2")!;
  assert.equal(r.status, "failed");
  assert.equal(r.steps[0].state, "failed");
});

test("another session cannot read someone else's progress", () => {
  startRun("a3", "s1");
  stepStart("a3", "Sending");
  assert.equal(getRun("other", "a3"), null);
  assert.equal(getRun("s1", "missing"), null);
});

test("steps added after the run ended are ignored", () => {
  startRun("a4", "s1");
  endRun("a4", true);
  stepStart("a4", "late");
  assert.equal(getRun("s1", "a4")!.steps.length, 0);
});
