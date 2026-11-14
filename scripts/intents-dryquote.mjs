// D1: ask NEAR Intents (1Click API) for a DRY quote. Nothing is executed or spent.
// Run: node --env-file=.env scripts/intents-dryquote.mjs [amountInNEAR] [destSymbol] [destChain]
const API = "https://1click.chaindefuser.com";
const JWT = process.env.INTENTS_JWT; // optional
const amountNear = process.argv[2] ?? "1";
const destSymbol = (process.argv[3] ?? "USDC").toUpperCase();
const destChain = (process.argv[4] ?? "near").toLowerCase();
const account = process.env.NEAR_AGENT_ACCOUNT_ID;
if (!account) {
  console.error("NEAR_AGENT_ACCOUNT_ID missing from .env");
  process.exit(1);
}

const headers = { "Content-Type": "application/json" };
if (JWT) headers.Authorization = `Bearer ${JWT}`;
console.log(JWT ? "Using partner JWT." : "No JWT: the extra unauthenticated fee applies.");

const tokens = await (await fetch(`${API}/v0/tokens`)).json();
console.log(`Supported tokens: ${tokens.length}`);

const origin = tokens.find((t) => t.assetId === "nep141:wrap.near");
const dest = tokens.find((t) => t.symbol?.toUpperCase() === destSymbol && t.blockchain?.toLowerCase() === destChain);
if (!origin || !dest) {
  console.error("Could not find tokens", { origin: !!origin, dest: !!dest });
  const alts = tokens.filter((t) => t.symbol?.toUpperCase() === destSymbol).map((t) => `${t.symbol}@${t.blockchain}`);
  console.error(`Available ${destSymbol} chains:`, alts.join(", "));
  process.exit(1);
}
console.log(`Origin: ${origin.symbol}@${origin.blockchain} (${origin.assetId}) price $${origin.price}`);
console.log(`Dest  : ${dest.symbol}@${dest.blockchain} (${dest.assetId}) price $${dest.price}`);

const amount = (BigInt(Math.round(Number(amountNear) * 1e6)) * 10n ** BigInt(origin.decimals - 6)).toString();

const body = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: origin.assetId,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: dest.assetId,
  amount,
  recipient: account, // agent account (public id)
  recipientType: "DESTINATION_CHAIN",
  refundTo: account,
  refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

const res = await fetch(`${API}/v0/quote`, { method: "POST", headers, body: JSON.stringify(body) });
const out = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status}`);
if (!res.ok) {
  console.log(JSON.stringify(out, null, 2).slice(0, 1500));
  process.exit(1);
}
const q = out.quote ?? out;
console.log(JSON.stringify(out, null, 2).slice(0, 3000));
if (q.amountOut && dest.decimals != null) {
  const outHuman = Number(q.amountOut) / 10 ** dest.decimals;
  console.log(`\nSummary: ${amountNear} ${origin.symbol} -> ~${outHuman} ${dest.symbol}`);
  if (q.amountOutUsd || q.amountInUsd) console.log(`USD in/out: ${q.amountInUsd} / ${q.amountOutUsd}`);
  if (q.timeEstimate != null) console.log(`Time estimate: ${q.timeEstimate}s`);
}
