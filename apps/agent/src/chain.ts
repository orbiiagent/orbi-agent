// The only file that talks to the NEAR network for writing. Everything else depends on the small `Chain` interface,
// so the logic can be tested with a recording fake and the real network is touched in one place.
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { config } from "./config.ts";

export type TxResult = { txHash: string; ok: boolean; failure?: string; returnValue?: string };
export type CallOpts = { depositYocto?: bigint; gas?: bigint; waitUntil?: "INCLUDED_FINAL" | "EXECUTED_OPTIMISTIC" | "FINAL" };

export interface Chain {
  readonly accountId: string;
  nativeBalance(): Promise<bigint>;
  view<T = unknown>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  accountExists(accountId: string): Promise<boolean>;
  call(contractId: string, method: string, args: Record<string, unknown>, opts?: CallOpts): Promise<TxResult>;
  transferNative(toAccountId: string, amountYocto: bigint): Promise<TxResult>;
}

export const TGAS = 1_000_000_000_000n;
export const rpcUrls = () =>
  config.network === "testnet" ? ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"] : config.rpcUrls;
export const explorerTx = (hash: string) => `https://${config.network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;

// ---- read-only helpers over plain JSON-RPC (no signing, no key) ----
async function rpc(params: Record<string, unknown>): Promise<any> {
  let last: unknown;
  for (const url of rpcUrls()) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "orbi", method: "query", params }) });
      const body: any = await res.json();
      if (body.error) {
        if (body.error.cause?.name === "UNKNOWN_ACCOUNT") throw new Error("UNKNOWN_ACCOUNT");
        throw new Error(JSON.stringify(body.error).slice(0, 200));
      }
      if (body.result?.error) throw new Error(String(body.result.error).slice(0, 200));
      return body.result;
    } catch (e) {
      if ((e as Error).message === "UNKNOWN_ACCOUNT") throw e;
      last = e;
    }
  }
  throw new Error(`NEAR RPC failed: ${(last as Error)?.message ?? last}`);
}
export async function viewCall<T = unknown>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc({ request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  const text = Buffer.from(r.result).toString("utf8");
  return (text ? JSON.parse(text) : null) as T;
}
export async function accountExistsOnChain(accountId: string): Promise<boolean> {
  try {
    await rpc({ request_type: "view_account", finality: "final", account_id: accountId });
    return true;
  } catch (e) {
    if ((e as Error).message === "UNKNOWN_ACCOUNT") return false;
    throw e;
  }
}

// ---- the real chain: signs with the agent key from the environment ----
function outcomeToResult(r: any): TxResult {
  const txHash = r?.transaction?.hash ?? r?.transaction_outcome?.id ?? "";
  const failures: string[] = [];
  const check = (status: any) => {
    if (status && typeof status === "object" && "Failure" in status) failures.push(JSON.stringify(status.Failure).slice(0, 240));
  };
  check(r?.status);
  for (const o of r?.receipts_outcome ?? []) check(o?.outcome?.status);
  const sv = r?.status && typeof r.status === "object" ? r.status.SuccessValue : undefined;
  return { txHash, ok: failures.length === 0, failure: failures[0], returnValue: typeof sv === "string" ? Buffer.from(sv, "base64").toString("utf8") : undefined };
}

export function realChain(): Chain {
  if (!config.agentAccount || !config.agentKey) throw new Error("Agent account or key is not configured");
  const provider = new JsonRpcProvider({ url: rpcUrls()[0] });
  const account = new Account(config.agentAccount, provider, KeyPairSigner.fromSecretKey(config.agentKey as any));
  return {
    accountId: config.agentAccount,
    nativeBalance: async () => {
      try {
        return await account.getBalance();
      } catch (e) {
        if (/UNKNOWN_ACCOUNT|does not exist/i.test((e as Error).message)) return 0n;
        throw e;
      }
    },
    view: viewCall,
    accountExists: accountExistsOnChain,
    async call(contractId, method, args, opts = {}) {
      const r = await account.callFunctionRaw({ contractId, methodName: method, args, deposit: opts.depositYocto ?? 0n, gas: opts.gas ?? 30n * TGAS, waitUntil: opts.waitUntil ?? "INCLUDED_FINAL" });
      return outcomeToResult(r);
    },
    async transferNative(to, amountYocto) {
      return outcomeToResult(await account.transfer({ receiverId: to, amount: amountYocto }));
    },
  };
}
