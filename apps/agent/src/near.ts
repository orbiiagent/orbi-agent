// Read-only NEAR RPC helpers (public RPC, no key needed).
import { rpcUrls } from "./chain.ts";
import { TOKENS, fromUnits } from "./tokens.ts";

async function rpc(params: Record<string, unknown>): Promise<any> {
  let lastErr: unknown;
  for (const url of rpcUrls()) { // follows ORBI_NETWORK: mainnet or testnet
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "orbi", method: "query", params }),
      });
      const body = await res.json();
      if (body.error) {
        if (body.error.cause?.name === "UNKNOWN_ACCOUNT") throw new Error("UNKNOWN_ACCOUNT");
        throw new Error(JSON.stringify(body.error).slice(0, 200));
      }
      // A contract call can fail inside the VM when the contract account does not exist.
      if (body.result?.error && /UNKNOWN_ACCOUNT|does not exist/i.test(String(body.result.error))) throw new Error("UNKNOWN_ACCOUNT");
      return body.result;
    } catch (e) {
      if ((e as Error).message === "UNKNOWN_ACCOUNT") throw e; // a real answer, do not try other RPCs
      lastErr = e;
    }
  }
  throw new Error(`NEAR RPC failed: ${(lastErr as Error)?.message ?? lastErr}`);
}

export async function nativeBalance(account: string): Promise<bigint> {
  try {
    const r = await rpc({ request_type: "view_account", finality: "final", account_id: account });
    return BigInt(r.amount);
  } catch (e) {
    // Implicit accounts do not exist on-chain until funded: treat as zero.
    if (/UnknownAccount|does not exist|UNKNOWN_ACCOUNT/i.test((e as Error).message)) return 0n;
    throw e;
  }
}

export async function ftBalance(contract: string, account: string): Promise<bigint> {
  try {
    const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
    const r = await rpc({
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: "ft_balance_of",
      args_base64: args,
    });
    const text = Buffer.from(r.result).toString("utf8").replace(/"/g, "");
    return BigInt(text || "0");
  } catch (e) {
    if (/UnknownAccount|does not exist|UNKNOWN_ACCOUNT/i.test((e as Error).message)) return 0n;
    throw e;
  }
}

export async function allBalances(account: string) {
  const fts = Object.values(TOKENS).filter((t) => t.contract);
  const [native, ...rest] = await Promise.all([
    nativeBalance(account),
    ...fts.map((t) => ftBalance(t.contract as string, account)),
  ]);
  return [
    { symbol: "NEAR", amount: fromUnits(native, 24) },
    ...fts.map((t, i) => ({ symbol: t.symbol, amount: fromUnits(rest[i], t.decimals) })),
  ];
}
