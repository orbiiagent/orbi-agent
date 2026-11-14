import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "orbi-research-"));
const file = join(dir, "research.json");
process.env.ORBI_RESEARCH_CACHE = file;
const { loadResearchFromDisk, researchReady, getPrices } = await import("../src/research.ts");

test("not ready before anything is loaded, and a missing or broken copy is harmless", () => {
  assert.equal(researchReady(), false);
  assert.equal(loadResearchFromDisk(), false); // no file yet
  writeFileSync(file, "{not json");
  assert.equal(loadResearchFromDisk(), false); // unreadable copy
  assert.equal(researchReady(), false);
});

test("a saved copy makes prices answerable at once, with no download", async () => {
  const tokens = [{ symbol: "wNEAR", blockchain: "near", price: 4.1, priceUpdatedAt: "x" }];
  writeFileSync(file, JSON.stringify({ pools: null, tokens: { at: Date.now() - 5_000, tokens } }));
  assert.equal(loadResearchFromDisk(), true);
  assert.equal(researchReady(), true);
  const r: any = await getPrices(["NEAR"]);
  assert.equal(r.prices[0].usd, 4.1);
  assert.ok(r.age_seconds >= 5); // the age is reported, never presented as live
});

test("a copy dated in the future is ignored", () => {
  writeFileSync(file, JSON.stringify({ pools: { at: Date.now() + 3_600_000, pools: [] }, tokens: null }));
  loadResearchFromDisk(); // must not throw; the future-dated pools are rejected
});
