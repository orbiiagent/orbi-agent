import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multiUser, validOwner, ownerFromCookie, ownerCookie, scoped, bindSession, ownerOf, sessionBelongsTo, ensureDir, OwnerError } from "../src/owner.ts";
import { addNote, listNotes, forgetNote, clearNotes, memoryPrompt } from "../src/memory.ts";
import { addContact, listContacts, resolveContact, removeContact } from "../src/contacts.ts";
import { computeHabits } from "../src/habits.ts";
import { getRefundAddress, setRefundAddress, proposeDeposit, BridgeError } from "../src/bridge.ts";

const A = "a".repeat(32);
const B = "b".repeat(32);
const ADDR = "0x" + "1".repeat(40);
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbi-owner-"));
  process.env.ORBI_MULTIUSER = "on";
  process.env.ORBI_DATA_DIR = dir;
  delete process.env.ORBI_MEMORY_FILE;
  delete process.env.ORBI_CONTACTS_FILE;
  delete process.env.ORBI_BRIDGE_FILE;
});
afterEach(() => {
  delete process.env.ORBI_MULTIUSER;
  delete process.env.ORBI_DATA_DIR;
  delete process.env.ORBI_MAX_OWNERS;
});

test("owner ids and the cookie", () => {
  assert.ok(validOwner(A));
  for (const bad of ["", "abc", "A".repeat(32), "../" + "a".repeat(29), "a".repeat(33), 7, undefined]) assert.equal(validOwner(bad), false);
  assert.equal(ownerFromCookie(`x=1; orbi_owner=${A}; y=2`), A);
  assert.equal(ownerFromCookie("orbi_owner=../../etc"), undefined);
  assert.equal(ownerFromCookie(undefined), undefined);
  assert.match(ownerCookie(A, false), /HttpOnly; SameSite=Strict$/);
  assert.match(ownerCookie(A, true), /; Secure$/);
});

test("hosted mode never falls back to the shared files", () => {
  assert.throws(() => scoped("/shared/memory.json", "memory.json", undefined), OwnerError);
  assert.throws(() => scoped("/shared/memory.json", "memory.json", "../x"), OwnerError);
  assert.equal(scoped("/shared/memory.json", "memory.json", A), join(dir, "owners", A, "memory.json"));
  delete process.env.ORBI_MULTIUSER;
  assert.equal(scoped("/shared/memory.json", "memory.json", undefined), "/shared/memory.json"); // your own computer is unchanged
});

test("memory is private to each browser, and an unknown visitor sees nothing", () => {
  addNote("Prefers short answers", A);
  assert.deepEqual(listNotes(A).map((n) => n.text), ["Prefers short answers"]);
  assert.deepEqual(listNotes(B), []);
  assert.deepEqual(listNotes(undefined), []);
  assert.equal(memoryPrompt(B), "");
  assert.match(memoryPrompt(A), /Prefers short answers/);
  assert.throws(() => addNote("Likes NEAR", undefined), OwnerError);
  assert.equal(forgetNote("short answers", B).removed.length, 0);
  assert.equal(clearNotes(B), 0);
  assert.equal(listNotes(A).length, 1);
  assert.equal(forgetNote("short answers", A).removed.length, 1);
});

test("on a hosted copy nobody can add or remove contacts, and everyone sees the same single one", () => {
  assert.throws(() => addContact("Alice", "alice.near", A), /switched off on this shared demo/);
  assert.equal(resolveContact("alice", A), null);
  assert.equal(removeContact("anything", A), false);
  assert.deepEqual(listContacts(A), listContacts(B)); // the same for everybody (Treasury if one is configured, otherwise none)
  assert.ok(listContacts(A).length <= 1);
  assert.ok(!existsSync(join(dir, "owners", A, "contacts.json")), "nothing is written for contacts");
});

test("the refund address is per visitor, and the machine-wide one in .env is ignored", () => {
  process.env.ORBI_BASE_REFUND_ADDRESS = "0x" + "2".repeat(40);
  assert.equal(getRefundAddress(A), null);
  setRefundAddress(ADDR, A);
  assert.equal(getRefundAddress(A), ADDR);
  assert.equal(getRefundAddress(B), null);
  delete process.env.ORBI_BASE_REFUND_ADDRESS;
});

test("bringing money in is switched off on a hosted copy", async () => {
  await assert.rejects(() => proposeDeposit("s1", { amount: 5 }), (e: Error) => e instanceof BridgeError && /shared demo/.test(e.message));
});

test("habits count only the visitor's own entries", () => {
  const f = join(dir, "activity.jsonl");
  const row = (owner: string, id: string, amount: string) => [
    { event: "proposed", id, owner, mode: "live", network: "mainnet", action: { kind: "swap", from: "NEAR", to: "USDC", amount } },
    { event: "done", id, owner, ok: true, simulated: false },
  ];
  writeFileSync(f, [...row(A, "1", "1"), ...row(B, "2", "5")].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.match(computeHabits(f, A).join(" "), /Last swap: 1 NEAR/);
  assert.match(computeHabits(f, B).join(" "), /Last swap: 5 NEAR/);
  assert.deepEqual(computeHabits(f, undefined), []);
  assert.deepEqual(computeHabits(f, "c".repeat(32)), []);
});

test("sessions belong to the browser that made them", () => {
  bindSession("sess-1", A);
  assert.equal(ownerOf("sess-1"), A);
  assert.ok(sessionBelongsTo("sess-1", A));
  assert.ok(!sessionBelongsTo("sess-1", B));
  assert.ok(!sessionBelongsTo("sess-1", undefined));
  delete process.env.ORBI_MULTIUSER;
  assert.ok(sessionBelongsTo("sess-1", B)); // single user: no cookie needed
  assert.equal(multiUser(), false);
});

test("a hosted copy stops taking new visitors when full, but existing ones keep working", () => {
  process.env.ORBI_MAX_OWNERS = "2";
  addNote("one", A);
  addNote("two", B);
  assert.equal(readdirSync(join(dir, "owners")).length, 2);
  assert.throws(() => addNote("three", "c".repeat(32)), (e: Error) => e instanceof OwnerError && /full/.test(e.message));
  assert.doesNotThrow(() => addNote("more", A));
  assert.ok(existsSync(join(dir, "owners", A)));
  assert.ok(!existsSync(join(dir, "owners", "c".repeat(32))));
});
