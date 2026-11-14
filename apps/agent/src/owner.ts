// Who is talking to Orbi. By default (running on your own computer) there is one owner and every file stays where it is.
// With ORBI_MULTIUSER=on (a hosted copy) each browser gets its own private id, and memory, habits, contacts and the
// refund address are kept per id. An unknown or missing id NEVER falls back to the shared files.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const multiUser = () => process.env.ORBI_MULTIUSER === "on";
const maxOwners = () => Number(process.env.ORBI_MAX_OWNERS || 2000);

const dataDir = () => process.env.ORBI_DATA_DIR || fileURLToPath(new URL("../../../.data/", import.meta.url));
const OWNER_RE = /^[a-f0-9]{32}$/;
export const validOwner = (s: unknown): s is string => typeof s === "string" && OWNER_RE.test(s);

export class OwnerError extends Error {}

// The file for this owner. Single-user mode: the usual file. Hosted mode: .data/owners/<id>/<name>.
export function scoped(defaultFile: string, name: string, owner?: string): string {
  if (!multiUser()) return defaultFile;
  if (!validOwner(owner)) throw new OwnerError("I can't tell who you are yet. Reload the page and try again.");
  return join(dataDir(), "owners", owner, name);
}

// Create the folder for a file. A hosted copy refuses new owners once it holds too many, so it can't be filled up.
export function ensureDir(file: string) {
  const dir = dirname(file);
  if (multiUser() && !existsSync(dir)) {
    const root = join(dataDir(), "owners");
    if (existsSync(root) && readdirSync(root).length >= maxOwners()) throw new OwnerError("This shared demo is full right now. Try again later.");
  }
  mkdirSync(dir, { recursive: true });
}

// ---- which owner a chat session belongs to (set by the server from the browser's cookie) ----
const sessionOwner = new Map<string, string>();
export function bindSession(session: string, owner?: string) {
  if (multiUser() && validOwner(owner)) sessionOwner.set(session, owner);
}
// The network address a session last came from, kept only as a short one-way hash (the log never holds a raw address).
const sessionIp = new Map<string, string>();
export const hashIp = (ip: string) => createHash("sha256").update(`${process.env.ORBI_IP_SALT || "orbi"}|${ip}`).digest("hex").slice(0, 16);
export function bindSessionIp(session: string, ip?: string) {
  if (multiUser() && ip && ip !== "unknown") sessionIp.set(session, hashIp(ip));
}
export const ipHashOf = (session?: string): string | undefined => (session ? sessionIp.get(session) : undefined);
export const unbindSession = (session: string) => {
  sessionOwner.delete(session);
  sessionIp.delete(session);
};
export const ownerOf = (session?: string): string | undefined => (session ? sessionOwner.get(session) : undefined);
// True when this session may be used by this owner (always true on your own computer).
export const sessionBelongsTo = (session: string, owner?: string) => !multiUser() || (validOwner(owner) && sessionOwner.get(session) === owner);

// ---- the private id in the browser's cookie ----
export function ownerFromCookie(header: string | undefined): string | undefined {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "orbi_owner" && validOwner(v.join("="))) return v.join("=");
  }
  return undefined;
}
export const ownerCookie = (id: string, secure: boolean) =>
  `orbi_owner=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
