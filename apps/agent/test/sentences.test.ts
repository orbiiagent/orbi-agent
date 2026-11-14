import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSplitter } from "../src/sentences.ts";

function run(chunks: string[]) {
  const out: string[] = [];
  const s = makeSplitter((x) => out.push(x));
  for (const c of chunks) s.push(c);
  s.flush();
  return out;
}

test("never splits inside a decimal number", () => {
  const out = run(["Rhea pays about 11.69 percent on USDC right now. Want more?"]);
  assert.deepEqual(out, ["Rhea pays about 11.69 percent on USDC right now.", "Want more?"]);
});

test("merges a very short first sentence with the next one", () => {
  const out = run(["Sure! Rhea is paying about 11 percent on USDC. It can move."]);
  assert.equal(out[0], "Sure! Rhea is paying about 11 percent on USDC.");
  assert.equal(out[1], "It can move.");
});

test("works when text arrives in tiny fragments", () => {
  const text = "That rate is variable, so it can move over time. Want me to compare it?";
  const out = run(text.split(""));
  assert.deepEqual(out, ["That rate is variable, so it can move over time.", "Want me to compare it?"]);
});

test("flushes trailing text without punctuation", () => {
  assert.deepEqual(run(["Okay, checking"]), ["Okay, checking"]);
});

test("empty input emits nothing", () => {
  assert.deepEqual(run([]), []);
  assert.deepEqual(run(["   "]), []);
});
