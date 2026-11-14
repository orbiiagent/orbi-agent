// DRY RUN of a real swap or send: runs the exact executor code against real mainnet data, but every transaction is only
// RECORDED, never signed or sent. Safe to run with an empty wallet. Shows what the first real transaction would do and cost.
//   node --env-file=.env scripts/dry-run.mjs swap USDC NEAR 2 [--native 5] [--usdc 10]
//   node --env-file=.env scripts/dry-run.mjs send NEAR 1 Treasury
import { config } from "../apps/agent/src/config.ts";
import { viewCall, accountExistsOnChain } from "../apps/agent/src/chain.ts";
import { executeSwapRhea, executeSend } from "../apps/agent/src/executor.ts";
import { rheaRoute } from "../apps/agent/src/quotes.ts";
import { resolveContact } from "../apps/agent/src/contacts.ts";
import { findToken, toUnits, fromUnits } from "../apps/agent/src/tokens.ts";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const [kind, ...rest] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const me = config.agentAccount;
const realNative = await viewCall("wrap.near", "storage_balance_of", { account_id: me }).then(() => null).catch(() => null); // warm RPC
async function realBalance() {
  const r = await fetch(config.rpcUrls[0], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: me } }) });
  const j = await r.json(); return j.result?.amount ? BigInt(j.result.amount) : 0n;
}
const pretendNative = flag("native") ? BigInt(toUnits(flag("native"), 24)) : null;
const real = await realBalance();
const native = pretendNative ?? real;
const planned = [];
let swapped = false;
const chain = {
  accountId: me,
  nativeBalance: async () => native,
  accountExists: accountExistsOnChain,
  view: async (c, m, a) => {
    if (m === "ft_balance_of" && a.account_id === me) {
      const f = findToken(kind === "swap" ? rest[0] : rest[0]);
      if (flag("usdc") && c === findToken("USDC").contract) return toUnits(flag("usdc"), 6);
      if (flag("usdt") && c === findToken("USDT").contract) return toUnits(flag("usdt"), 6);
    }
    return viewCall(c, m, a);
  },
  call: async (contract, method, a, o = {}) => { planned.push({ contract, method, args: a, deposit: o.depositYocto ?? 0n, gas: o.gas ?? 0n }); return { txHash: "DRY-RUN", ok: true }; },
  transferNative: async (to, amount) => { planned.push({ contract: to, method: "(native transfer)", args: {}, deposit: amount, gas: 0n }); return { txHash: "DRY-RUN", ok: true }; },
};
console.log(`Agent account : ${me}`);
console.log(`Real balance  : ${fromUnits(real, 24, 4)} NEAR${pretendNative !== null ? `   (pretending ${fromUnits(native, 24, 4)} NEAR for this dry run)` : ""}`);
console.log(`Orbi fee      : ${config.feeRecipient && config.feePerMille ? config.feePerMille / 10 + "% to " + config.feeRecipient.slice(0, 10) + "…" : "off"}\n`);
try {
  let result;
  if (kind === "swap") {
    const [from, to, amount] = rest;
    const { route, feeOn } = await rheaRoute(from, to, amount);
    console.log(`Route tokens  : ${route.tokens.join(", ")}`);
    result = await executeSwapRhea({ kind: "swap", from: from.toUpperCase(), to: to.toUpperCase(), amount, route: "Rhea SmartRouter", estOut: "0", estOutUnits: "0" }, chain, { fetchRoute: async () => ({ route, feeOn }) });
  } else if (kind === "send") {
    const [token, amount, name] = rest;
    const c = resolveContact(name); if (!c) throw new Error(`No contact named ${name}`);
    result = await executeSend({ kind: "send", token: token.toUpperCase(), amount, toName: c.name, toAddress: c.address }, chain);
  } else throw new Error("usage: dry-run.mjs swap FROM TO AMOUNT | send TOKEN AMOUNT CONTACT");
} catch (e) { console.log(`STOPPED BEFORE SENDING ANYTHING: ${e.message}\n`); }
console.log(`Transactions that would be sent (${planned.length}):`);
let total = 0n;
planned.forEach((p, i) => { total += p.deposit; console.log(`  ${i + 1}. ${p.contract.length > 30 ? p.contract.slice(0, 14) + "…" : p.contract} . ${p.method}  deposit ${fromUnits(p.deposit, 24, 5)} NEAR  gas ${p.gas / 1_000_000_000_000n} Tgas`); });
console.log(`Total NEAR attached to those calls: ${fromUnits(total, 24, 5)} NEAR (plus gas, which is a fraction of a cent)`);
console.log("\nNothing was signed or sent.");
