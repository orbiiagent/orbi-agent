// Read-only history of what Orbi proposed and executed, built from its own audit log, plus a best-effort on-chain check.
// The log is written by actions.ts only; nothing here can move money.
import { readFileSync } from "node:fs";
import { config } from "./config.ts";

const RPCS: Record<"mainnet" | "testnet", string[]> = {
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
  testnet: ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"],
};
const explorerFor = (network: "mainnet" | "testnet", hash: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;

export type Onchain = "confirmed" | "failed" | "unknown";
export type Entry = {
  id: string;
  at: string; // when it was proposed
  finishedAt?: string;
  kind: "send" | "swap";
  token?: string; // sends: the token; swaps: what was given
  amount?: string;
  to?: string; // sends: contact name
  toToken?: string; // swaps: what was received
  estOut?: string; // swaps: the estimate shown on the card
  mode: "live" | "rehearsal";
  network?: "mainnet" | "testnet"; // older log lines did not record it
  status: "completed" | "failed" | "declined" | "in_progress" | "never_approved";
  simulated: boolean;
  txs: string[];
  explorer: string[];
  error?: string;
  onchain?: Onchain;
};

type Line = Record<string, any>;

export function readLog(file: string): Line[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return []; // no log yet: nothing has happened
  }
  const out: Line[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* a damaged line must not hide the rest */
    }
  }
  return out;
}

// Group the log by action id, oldest first.
export function entriesFromLog(lines: Line[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const l of lines) {
    const id = String(l.id ?? "");
    if (!id) continue;
    let e = byId.get(id);
    if (l.event === "proposed") {
      const a = l.action ?? {};
      e = {
        id,
        at: l.at,
        kind: a.kind === "swap" ? "swap" : "send",
        token: a.kind === "swap" ? a.from : a.token,
        amount: a.amount != null ? String(a.amount) : undefined,
        to: a.toName,
        toToken: a.kind === "swap" ? a.to : undefined,
        estOut: a.estOut != null ? String(a.estOut) : undefined,
        mode: l.mode === "live" ? "live" : "rehearsal",
        network: l.network === "testnet" ? "testnet" : l.network === "mainnet" ? "mainnet" : undefined,
        status: "never_approved",
        simulated: l.mode !== "live",
        txs: [],
        explorer: [],
      };
      byId.set(id, e);
      continue;
    }
    if (!e) continue;
    if (l.event === "approved") e.status = "in_progress";
    else if (l.event === "rejected") e.status = "declined";
    else if (l.event === "failed") {
      e.status = "failed";
      e.error = String(l.error ?? "").slice(0, 200);
      e.finishedAt = l.at;
    } else if (l.event === "done") {
      e.status = l.ok ? "completed" : "failed";
      e.simulated = Boolean(l.simulated);
      e.txs = Array.isArray(l.txs) ? l.txs.map(String) : [];
      e.finishedAt = l.at;
    }
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

// First answer that is not "unknown" wins; if none is, the result is "unknown" once everything has finished.
function firstDefinite<T extends { r: Onchain }>(tasks: Promise<T>[], none: T): Promise<T> {
  return new Promise((resolve) => {
    let left = tasks.length;
    if (!left) return resolve(none);
    for (const t of tasks)
      t.then((v) => { if (v.r !== "unknown") resolve(v); else if (--left === 0) resolve(none); }, () => { if (--left === 0) resolve(none); });
  });
}

// Ask one RPC whether a transaction really succeeded (the receipts too, which matter for swaps).
// A node that has never seen the hash keeps waiting, so every attempt has a short timeout.
async function txOnRpc(url: string, hash: string, signer: string): Promise<{ r: Onchain }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "orbi", method: "tx", params: { tx_hash: hash, sender_account_id: signer, wait_until: "EXECUTED" } }),
      signal: AbortSignal.timeout(3000),
    });
    const r = ((await res.json()) as any).result;
    if (!r) return { r: "unknown" };
    const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])];
    const failed = outcomes.some((o: any) => o?.outcome?.status && typeof o.outcome.status === "object" && "Failure" in o.outcome.status);
    if (failed || (r.status && typeof r.status === "object" && "Failure" in r.status)) return { r: "failed" };
    if (r.status && typeof r.status === "object" && ("SuccessValue" in r.status || "SuccessReceiptId" in r.status)) return { r: "confirmed" };
  } catch {
    /* no answer from this node */
  }
  return { r: "unknown" };
}

// If the log says which network, check only that one; older entries are looked up on both and the network that has it wins.
// All nodes are asked at once, so the answer arrives as soon as one of them knows.
async function verifyTx(hash: string, signer: string, known?: "mainnet" | "testnet"): Promise<{ result: Onchain; network?: "mainnet" | "testnet" }> {
  const nets: ("mainnet" | "testnet")[] = known ? [known] : ["testnet", "mainnet"];
  const tasks = nets.flatMap((n) => RPCS[n].map(async (url) => ({ ...(await txOnRpc(url, hash, signer)), n })));
  const hit = await firstDefinite(tasks, { r: "unknown" as Onchain, n: known as "mainnet" | "testnet" | undefined });
  return { result: hit.r, network: hit.r === "unknown" ? known : hit.n };
}

export type Recent = { account: string; network: string; count: number; transactions: Entry[]; last_unexecuted?: { status: Entry["status"]; at: string } };

// The most recent actions that were actually carried out (or tried), newest first.
export async function recentTransactions(file: string, count = 1, verify = true): Promise<Recent> {
  const n = Math.max(1, Math.min(5, Math.floor(count) || 1));
  const all = entriesFromLog(readLog(file));
  const executed = all.filter((e) => e.status === "completed" || e.status === "failed" || e.status === "in_progress").reverse();
  const picked = executed.slice(0, n);
  await Promise.all(picked.map(async (e) => {
    if (verify && e.mode === "live" && !e.simulated && e.status === "completed" && e.txs.length && config.agentAccount) {
      const checks = await Promise.all(e.txs.map((h) => verifyTx(h, config.agentAccount as string, e.network)));
      e.network = e.network ?? checks.find((c) => c.network && c.result !== "unknown")?.network;
      e.onchain = checks.some((c) => c.result === "failed") ? "failed" : checks.every((c) => c.result === "confirmed") ? "confirmed" : "unknown";
    }
    const net = e.network ?? config.network;
    e.explorer = e.txs.map((h) => explorerFor(net, h));
  }));
  // A newer proposal that never ran (declined, expired or still open) is worth a mention.
  const newest = all[all.length - 1];
  const last_unexecuted = newest && (newest.status === "declined" || newest.status === "never_approved") && (!picked[0] || newest.at > picked[0].at)
    ? { status: newest.status, at: newest.at }
    : undefined;
  return { account: config.agentAccount ?? "", network: config.network, count: picked.length, transactions: picked, last_unexecuted };
}
