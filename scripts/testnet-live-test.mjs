// Real signed transactions on NEAR TESTNET (play money). Refuses to run on mainnet.
//   ORBI_NETWORK=testnet ORBI_EXECUTION=live node --env-file=.env scripts/testnet-live-test.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const dir = mkdtempSync(`${tmpdir()}/orbi-testnet-`);
process.env.ORBI_CONTACTS_FILE = `${dir}/contacts.json`;   // throwaway: the real contact list is not touched
process.env.ORBI_ACTIVITY_FILE = `${dir}/activity.jsonl`;
const { config } = await import("../apps/agent/src/config.ts");
if (config.network !== "testnet" || config.executionMode !== "live") { console.error("Refusing to run: needs ORBI_NETWORK=testnet and ORBI_EXECUTION=live"); process.exit(1); }
const { rpcUrls } = await import("../apps/agent/src/chain.ts");
const { proposeSend, approve } = await import("../apps/agent/src/actions.ts");
const { addContact } = await import("../apps/agent/src/contacts.ts");
const { newPolicyState } = await import("../apps/agent/src/policy.ts");

const TREASURY = config.feeRecipient, GHOST = "orbi-no-such-account-xyz.testnet";
addContact("Treasury", TREASURY); addContact("Ghost", GHOST);
const fmt = (y) => (Number(y / 10n ** 18n) / 1e6).toFixed(6);
async function bal(id) {
  const j = await (await fetch(rpcUrls()[0], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }) })).json();
  return j.result ? BigInt(j.result.amount) : null;
}
const policy = newPolicyState(); let n = 0;
const attempt = async (label, fn) => { try { const r = await fn(); console.log(`   -> ${label}: OK`); return r; } catch (e) { console.log(`   -> ${label}: REFUSED: ${e.message}`); return null; } };

const a0 = await bal(config.agentAccount), t0 = await bal(TREASURY);
console.log(`Network ${config.network} | mode ${config.executionMode}`);
console.log(`Before: agent ${fmt(a0)} NEAR | Treasury ${t0 === null ? "does not exist yet" : fmt(t0) + " NEAR"}\n`);

console.log("1. Real send: 0.5 NEAR to Treasury (proposal -> card -> approve)");
const card = await proposeSend("t1", { token: "NEAR", amount: 0.5, to_name: "Treasury" }, policy);
console.log(`   card: "${card.title}" | mode ${card.mode} | warnings: ${card.warnings.join(" / ")}`);
const out = await approve("t1", card.id, card.hash, policy);
console.log(`   result: ok=${out.ok} simulated=${out.simulated}\n   Orbi says: "${out.spoken}"`);
for (const t of out.txs) console.log(`   tx: ${t.label} ${t.hash}\n   explorer: ${t.url}`);
await new Promise((r) => setTimeout(r, 3000));
const a1 = await bal(config.agentAccount), t1 = await bal(TREASURY);
console.log(`   after: agent ${fmt(a1)} (spent ${fmt(a0 - a1)} incl. fee) | Treasury ${fmt(t1)} NEAR (received ${fmt(t1 - (t0 ?? 0n))})`);
console.log(`   Treasury received exactly 0.5 NEAR: ${t1 - (t0 ?? 0n) === 500000000000000000000000n}`);
console.log(`   network fee paid: ${fmt(a0 - a1 - 500000000000000000000000n)} NEAR\n`);

config.maxActionUsd = 1000; config.maxDailyUsd = 1000; // so the BALANCE checks, not the dollar limits, are what we exercise
console.log("2. Refusals that must happen BEFORE anything is sent");
const before = await bal(config.agentAccount);
await attempt("send 50 NEAR (more than the wallet holds)", () => proposeSend("t2", { token: "NEAR", amount: 50, to_name: "Treasury" }, policy));
await attempt("send 4.4 NEAR (would leave less than the 0.2 NEAR reserve)", () => proposeSend("t2", { token: "NEAR", amount: 4.4, to_name: "Treasury" }, policy));
console.log(`   wallet unchanged after refusals: ${(await bal(config.agentAccount)) === before}\n`);

console.log("3. A contact whose account does not exist");
const g = await proposeSend("t3", { token: "NEAR", amount: 0.1, to_name: "Ghost" }, policy);
await attempt("approve the send to Ghost", () => approve("t3", g.id, g.hash, policy));
console.log(`   wallet unchanged: ${(await bal(config.agentAccount)) === before}\n`);

console.log("4. Double tap: two approvals of the same card at the same moment");
const d = await proposeSend("t4", { token: "NEAR", amount: 0.1, to_name: "Treasury" }, policy);
const t4before = await bal(TREASURY), a4before = await bal(config.agentAccount);
const res = await Promise.allSettled([approve("t4", d.id, d.hash, policy), approve("t4", d.id, d.hash, policy)]);
console.log(`   outcomes: ${res.map((r) => (r.status === "fulfilled" ? "executed" : "refused (" + r.reason.message + ")")).join(" | ")}`);
await new Promise((r) => setTimeout(r, 3000));
const t4after = await bal(TREASURY);
console.log(`   Treasury received ${fmt(t4after - t4before)} NEAR (exactly one 0.1 transfer: ${t4after - t4before === 100000000000000000000000n})\n`);

const a9 = await bal(config.agentAccount);
console.log(`Final: agent ${fmt(a9)} NEAR (total spent on testnet: ${fmt(a0 - a9)} NEAR, almost all of it moved to Treasury)`);
