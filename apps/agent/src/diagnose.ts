// Turns what the network recorded about a transaction into one plain sentence: why it failed, or why it did not do what was expected.
// Read-only: it only reads a transaction's public record. It never signs, sends or changes anything, and its text is for the owner to read.
import { rpcUrls } from "./chain.ts";
import { fromUnits } from "./tokens.ts";

// A raw failure (JSON from the network) in plain words. Unknown ones are kept as they are, short, so nothing is hidden.
export function explainFailure(raw: string | undefined): string {
  const f = String(raw ?? "");
  if (!f) return "unknown error";
  if (/GasExceeded|GasLimitExceeded|Exceeded the prepaid gas/i.test(f)) return "It ran out of gas, so the network stopped it.";
  if (/LackBalanceForState/.test(f)) return "The wallet doesn't have enough NEAR to cover the storage this needs.";
  if (/NotEnoughBalance|NotEnoughAllowance|insufficient/i.test(f)) return "There isn't enough balance to cover this.";
  if (/AccountDoesNotExist/.test(f)) return "The receiving account doesn't exist yet.";
  if (/is not registered|not registered|StorageNotRegistered|storage deposit/i.test(f)) return "The receiver isn't registered with this token yet.";
  if (/slippage|min_amount_out|MIN_AMOUNT|price moved/i.test(f)) return "The price moved more than allowed, so the router refused the swap.";
  const panic = /Smart contract panicked: ([^"\\]*)/.exec(f);
  if (panic) return `The contract refused it: ${panic[1].trim().slice(0, 140)}`;
  if (/MethodNotFound/.test(f)) return "The contract doesn't have that method.";
  return f.slice(0, 160);
}

// Reads a full transaction record (the shape the network returns) and finds the reason, or null if it sees nothing unusual.
export function explainStatus(status: any, me: string): string | null {
  const outcomes: any[] = [status?.transaction_outcome, ...(status?.receipts_outcome ?? [])].filter(Boolean);
  const failed = outcomes.map((o) => o.outcome?.status).filter((s) => s && typeof s === "object" && "Failure" in s);
  if (failed.length) return explainFailure(JSON.stringify(failed[0].Failure));
  // A swap "into NEAR" is paid out as wNEAR (wrapped NEAR): the swap worked, but plain NEAR did not go up.
  for (const o of outcomes) {
    if (o.outcome?.executor_id !== "wrap.near") continue;
    for (const log of o.outcome?.logs ?? []) {
      const m = /^Transfer (\d+) from \S+ to (\S+)$/.exec(String(log));
      if (m && m[2] === me) return `The swap worked, but the router paid you ${fromUnits(m[1], 24, 4)} wNEAR (wrapped NEAR) instead of plain NEAR. It's in your wallet as a token and can be unwrapped to NEAR.`;
    }
  }
  return null;
}

// Fetches the record (read-only) and explains it. Never throws: no answer is better than a wrong one.
export async function diagnoseTx(txHash: string, sender: string): Promise<string | null> {
  if (!txHash) return null;
  for (const url of rpcUrls()) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "orbi", method: "EXPERIMENTAL_tx_status", params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" } }) });
      const body: any = await res.json();
      if (body.result) return explainStatus(body.result, sender);
    } catch { /* try the next one */ }
  }
  return null;
}
