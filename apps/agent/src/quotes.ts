// Quote sources: NEAR Intents (1Click, dry quote) and Rhea SmartRouterV2. Read-only, nothing is executed.
import { config } from "./config.ts";
import { findToken, fromUnits, toUnits } from "./tokens.ts";

export type Route = {
  source: "NEAR Intents" | "Rhea SmartRouter";
  amountOut: string; // human units of the output token, AFTER Orbi's fee (estimate where noted)
  amountOutUnits: bigint;
  amountOutBeforeFee?: string; // only set when Orbi's fee is deducted by Orbi's own estimate
  usdIn?: number;
  usdOut?: number;
  etaSeconds?: number;
  orbiFeePct: number; // Orbi's own routing fee on this route (0 when not applied)
  note?: string;
};

// perMille: 1 = 0.1%. Rounds down, so the estimate never overstates what the user receives.
export function applyFee(units: bigint, perMille: number): bigint {
  return (units * BigInt(1000 - perMille)) / 1000n;
}

export async function intentsQuote(fromSym: string, toSym: string, amount: string): Promise<Route> {
  const from = findToken(fromSym);
  const to = findToken(toSym);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.intentsJwt) headers.Authorization = `Bearer ${config.intentsJwt}`;
  const account = config.agentAccount;
  if (!account) throw new Error("NEAR_AGENT_ACCOUNT_ID is not set");
  const res = await fetch(`${config.intentsApi}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: Math.round(config.slippage * 10000),
      originAsset: `nep141:${from.swapContract}`,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: `nep141:${to.swapContract}`,
      amount: toUnits(amount, from.decimals),
      recipient: account,
      recipientType: "DESTINATION_CHAIN",
      refundTo: account,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Intents quote failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  const q = body.quote;
  return {
    source: "NEAR Intents",
    amountOut: fromUnits(q.amountOut, to.decimals),
    amountOutUnits: BigInt(q.amountOut),
    usdIn: q.amountInUsd ? Number(q.amountInUsd) : undefined,
    usdOut: q.amountOutUsd ? Number(q.amountOutUsd) : undefined,
    etaSeconds: q.timeEstimate,
    orbiFeePct: 0,
    note: "Intents fee is included in the quoted output.",
  };
}

export type RheaRoute = { amount_in: string; amount_out: string; min_amount_out: string; msg: string; signature: string; tokens: string[] };

// The raw route as the router returns it. `msg` and `signature` are what a swap must send, so the same user,
// receiver and fee parameters have to be used here as at execution time.
export async function rheaRoute(fromSym: string, toSym: string, amount: string): Promise<{ route: RheaRoute; feeOn: boolean }> {
  const from = findToken(fromSym);
  const to = findToken(toSym);
  const params = new URLSearchParams({
    amountIn: toUnits(amount, from.decimals),
    tokenIn: from.swapContract,
    tokenOut: to.swapContract,
    slippage: String(config.slippage),
    user: config.agentAccount,
    receiveUser: config.agentAccount,
  });
  const feeOn = Boolean(config.feeRecipient) && config.feePerMille > 0;
  if (feeOn) {
    params.set("appFeeRate", String(config.feePerMille));
    params.set("appFeeRecipient", config.feeRecipient);
  }
  const res = await fetch(`${config.rheaRouter}?${params}`);
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Rhea quote failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  // The response may be wrapped; find the object that holds amount_out.
  const data = body.amount_out !== undefined ? body : (body.result_data ?? body.data ?? body.result ?? body);
  if (data?.amount_out === undefined) throw new Error(`Rhea quote had no amount_out: ${JSON.stringify(body).slice(0, 200)}`);
  return { route: data as RheaRoute, feeOn };
}

export async function rheaQuote(fromSym: string, toSym: string, amount: string): Promise<Route> {
  const to = findToken(toSym);
  const { route, feeOn } = await rheaRoute(fromSym, toSym, amount);
  const gross = BigInt(route.amount_out);
  // Tested live: the router returns the SAME amount_out with and without appFeeRate, so its quote does not
  // include Orbi's fee. We deduct it ourselves (assuming it is taken from the output) and label it an estimate.
  const net = feeOn ? applyFee(gross, config.feePerMille) : gross;
  return {
    source: "Rhea SmartRouter",
    amountOut: fromUnits(net, to.decimals),
    amountOutUnits: net,
    amountOutBeforeFee: feeOn ? fromUnits(gross, to.decimals) : undefined,
    orbiFeePct: feeOn ? config.feePerMille / 10 : 0,
    note: feeOn
      ? "Estimate after Orbi's fee: the router's own quote excludes it, and exactly how the fee is taken is only confirmed when a swap executes. Storage registration may be needed before swapping."
      : "Storage registration may be needed before swapping.",
  };
}

export async function compareRoutes(fromSym: string, toSym: string, amount: string) {
  const settled = await Promise.allSettled([intentsQuote(fromSym, toSym, amount), rheaQuote(fromSym, toSym, amount)]);
  const routes: Route[] = [];
  const errors: string[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") routes.push(s.value);
    else errors.push((s.reason as Error).message);
  }
  routes.sort((a, b) => (a.amountOutUnits > b.amountOutUnits ? -1 : a.amountOutUnits < b.amountOutUnits ? 1 : 0));
  return { routes, best: routes[0], errors };
}
