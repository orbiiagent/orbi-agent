// Saved contacts. Orbi never takes an address from speech: you say a NAME, and it maps to an address you saved by
// typing or pasting. Stored in a local git-ignored file.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { ensureDir, multiUser, scoped } from "./owner.ts";

export type Contact = { name: string; address: string; sends: number }; // sends: how many times we have paid this address

// `owner` is only used on a hosted copy (ORBI_MULTIUSER=on): every browser then has its own contacts.
const FILE = (owner?: string) => scoped(process.env.ORBI_CONTACTS_FILE || fileURLToPath(new URL("../../../.data/contacts.json", import.meta.url)), "contacts.json", owner);
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const MAX_CONTACTS = 20;

export function validAddress(raw: string): string | null {
  const a = raw.trim().toLowerCase();
  if (a.length < 2 || a.length > 64 || !ACCOUNT_RE.test(a)) return null;
  return a;
}
const normName = (n: string) => n.trim().replace(/\s+/g, " ");
const key = (n: string) => normName(n).toLowerCase();

function load(owner?: string): Contact[] {
  try {
    const data = JSON.parse(readFileSync(FILE(owner), "utf8"));
    return Array.isArray(data) ? data.filter((c) => c && typeof c.name === "string" && typeof c.address === "string") : [];
  } catch {
    return [];
  }
}
function save(list: Contact[], owner?: string) {
  ensureDir(FILE(owner));
  writeFileSync(FILE(owner), JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}

// First run: one saved contact, the human's own fee wallet, so the "send to a contact" demo works. It can be deleted.
export function seedDefaultContacts() {
  if (multiUser() || existsSync(FILE()) || !config.feeRecipient) return; // a hosted copy starts everyone with no contacts
  save([{ name: "Treasury", address: config.feeRecipient, sends: 0 }]);
}

// A shared demo has exactly one contact for everyone: Treasury, the project owner's own wallet, so sent funds come back.
// Nobody can add or remove contacts there.
const demoContacts = (): Contact[] => (config.feeRecipient ? [{ name: "Treasury", address: config.feeRecipient, sends: 1 }] : []);
const DEMO_LOCKED = "Adding or removing contacts is switched off on this shared demo. You can send to Treasury.";
export const listContacts = (owner?: string): Contact[] => (multiUser() ? demoContacts() : load(owner));
export const resolveContact = (name: string, owner?: string): Contact | null => (multiUser() ? demoContacts() : load(owner)).find((c) => key(c.name) === key(name)) ?? null;

export function addContact(rawName: string, rawAddress: string, owner?: string): Contact {
  if (multiUser()) throw new Error(DEMO_LOCKED);
  const name = normName(rawName);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/.test(name)) throw new Error("Names are 1 to 24 letters, numbers, spaces, dashes or underscores.");
  const address = validAddress(rawAddress);
  if (!address) throw new Error("That doesn't look like a NEAR account address.");
  if (address === config.agentAccount.toLowerCase()) throw new Error("That's Orbi's own wallet, not a contact.");
  const list = load(owner);
  if (list.length >= MAX_CONTACTS) throw new Error(`You can save up to ${MAX_CONTACTS} contacts.`);
  if (list.some((c) => key(c.name) === key(name))) throw new Error("A contact with that name already exists.");
  if (list.some((c) => c.address === address)) throw new Error("That address is already saved under another name.");
  const contact = { name, address, sends: 0 };
  save([...list, contact], owner);
  return contact;
}

// Before saving, ask the network whether the account is real. `exists` is passed in so this stays testable.
//  - exists: fine.
//  - named account (like eric.near) that does not exist: refuse, it is almost certainly a typo.
//  - 64-character account that does not exist yet: allowed, the first payment creates it (the card already warns about that).
//  - the network could not be reached: allowed, with a note.
export type AccountCheck = { ok: true; notice?: string } | { ok: false; error: string };
export async function checkNewContact(rawAddress: string, exists: (id: string) => Promise<boolean>, timeoutMs = 6000): Promise<AccountCheck> {
  const address = validAddress(rawAddress);
  if (!address) return { ok: false, error: "That doesn't look like a NEAR account address." };
  let found: boolean | "unknown";
  try {
    found = await Promise.race([exists(address), new Promise<"unknown">((resolve) => setTimeout(() => resolve("unknown"), timeoutMs))]);
  } catch {
    found = "unknown";
  }
  if (found === true) return { ok: true };
  if (found === "unknown") return { ok: true, notice: "Saved, but I couldn't check the network just now, so please double-check the address." };
  if (/^[0-9a-f]{64}$/.test(address)) return { ok: true, notice: "Saved. That address hasn't been used yet, so the first payment will create the account." };
  return { ok: false, error: `I can't find ${address} on ${config.network}. Check the spelling, or that it's a ${config.network} account.` };
}

export function removeContact(name: string, owner?: string): boolean {
  if (multiUser()) return false;
  const list = load(owner);
  const next = list.filter((c) => key(c.name) !== key(name));
  if (next.length === list.length) return false;
  save(next, owner);
  return true;
}

export function recordSend(name: string, owner?: string) {
  if (multiUser()) return;
  const list = load(owner);
  const c = list.find((x) => key(x.name) === key(name));
  if (c) {
    c.sends++;
    save(list, owner);
  }
}
