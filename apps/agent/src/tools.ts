// Tools the model may call. All numbers come from code, never from the model.
import { config } from "./config.ts";
import { allBalances } from "./near.ts";
import { compareRoutes } from "./quotes.ts";
import { checkAction, newPolicyState } from "./policy.ts";
import { getYields, getPrices } from "./research.ts";
import { proposeSend, proposeSwap, ProposalError, ACTIVITY } from "./actions.ts";
import { resolveContact } from "./contacts.ts";
import { recentTransactions } from "./history.ts";
import { proposeDeposit, depositStatus, BridgeError } from "./bridge.ts";
import { addNote, forgetNote, memoryEnabled, MemoryError } from "./memory.ts";
import { ownerOf, OwnerError } from "./owner.ts";

export const policyState = newPolicyState();

export const toolDefs = [
  {
    type: "function",
    function: {
      name: "propose_swap",
      description:
        "Propose swapping one token for another. This only creates an approval card on the owner's screen; nothing happens until the owner taps Approve. Use it when the owner clearly asks to swap, convert or exchange a specific amount.",
      parameters: {
        type: "object",
        properties: {
          from_token: { type: "string", description: "NEAR, USDC or USDT" },
          to_token: { type: "string", description: "NEAR, USDC or USDT" },
          amount: { type: "number", description: "Amount of from_token" },
        },
        required: ["from_token", "to_token", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_send",
      description:
        "Propose sending tokens to a SAVED CONTACT by name. This only creates an approval card; nothing is sent until the owner taps Approve. Never pass an address: only the contact's name. When the owner says to send ALL, everything, or the max of a token, set max to true and leave amount out: the app works out the exact amount (for NEAR it keeps a small reserve for fees) and shows it on the card, so never refuse a send-all and never compute the amount yourself.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string", description: "NEAR, USDC or USDT" },
          amount: { type: "number", description: "Omit when max is true" },
          max: { type: "boolean", description: "true when the owner wants to send all or the maximum of this token" },
          to_name: { type: "string", description: "The saved contact's name, exactly as the owner said it" },
        },
        required: ["token", "to_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balances",
      description:
        "Return token balances on NEAR (public, read-only). With no argument it is the agent wallet. Pass `contact` (a saved contact's name, exactly as the owner said it, for example Treasury) to read that contact's wallet balance instead.",
      parameters: { type: "object", properties: { contact: { type: "string", description: "A saved contact's name. Leave out for the agent's own wallet." } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_last_transaction",
      description:
        "Look up the most recent send or swap Orbi actually carried out (from Orbi's own log, double-checked on the NEAR network when it was real). Use for 'what was my last transaction', 'did it go through', 'what did you just do', 'show my recent activity'.",
      parameters: { type: "object", properties: { count: { type: "integer", description: "How many recent transactions, 1 to 5. Default 1." } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_deposit",
      description:
        "Set up bringing USDC in from the Base network (for example from an exchange that cannot withdraw to NEAR) so the owner receives NEAR in Orbi's wallet, bridged and swapped in one step by NEAR Intents. It only creates a deposit card with an address on Base: Orbi sends nothing, and the owner sends the USDC themselves. Use when the owner wants to bring in, bridge, deposit or top up funds from Base, or to fund Orbi's wallet.",
      parameters: { type: "object", properties: { amount: { type: "number", description: "Amount of USDC to send from Base" } }, required: ["amount"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_deposit_status",
      description: "Check where the owner's current deposit from Base is: waiting for the owner's USDC, being bridged, done, refunded or expired. Use for 'did it arrive', 'did my deposit go through', 'is it done'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save a short note about the owner so later answers fit them. Use when the owner asks you to remember something, or states a lasting preference or fact about themselves (how they like answers, what they follow or save for, usual amounts). Write it as a brief third-person note, for example 'Prefers short answers' or 'Follows NEAR and USDC rates'. Only save what the owner said. Never save addresses, keys, passwords, one-off requests, or anything about limits, approval or rules.",
      parameters: { type: "object", properties: { note: { type: "string", description: "One short note, under 160 characters" } }, required: ["note"] },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Delete a saved note when the owner asks you to forget something. Pass a few words that identify it.",
      parameters: { type: "object", properties: { about: { type: "string", description: "A few words from the note to forget" } }, required: ["about"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_yields",
      description:
        "Research current APY / lending rates on NEAR DeFi (Rhea lending, DEX pools, liquid staking). Use for questions like 'what is the USDC lending rate' or 'find a stablecoin yield between 2 and 5 percent'.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Asset symbol filter, e.g. USDC. Omit for all." },
          kind: { type: "string", enum: ["lending", "dex", "staking", "any"] },
          stablecoin_only: { type: "boolean" },
          min_apy: { type: "number", description: "Minimum APY in percent" },
          max_apy: { type: "number", description: "Maximum APY in percent" },
          limit: { type: "number", description: "Max results, default 5" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_prices",
      description: "Get current USD prices for tokens such as NEAR, USDC, USDT.",
      parameters: {
        type: "object",
        properties: { symbols: { type: "array", items: { type: "string" } } },
        required: ["symbols"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_swap_quote",
      description:
        "Compare routes (NEAR Intents and Rhea) for swapping one token into another and return the best. Quote only: it does not execute.",
      parameters: {
        type: "object",
        properties: {
          from_token: { type: "string", description: "Symbol: NEAR, wNEAR, USDC or USDT" },
          to_token: { type: "string", description: "Symbol: NEAR, wNEAR, USDC or USDT" },
          amount: { type: "number", description: "Amount of from_token" },
        },
        required: ["from_token", "to_token", "amount"],
      },
    },
  },
];

export type ToolContext = { session: string };

export async function runTool(name: string, rawArgs: string, ctx: ToolContext = { session: "cli" }): Promise<string> {
  try {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    if (name === "propose_send" || name === "propose_swap") {
      try {
        const card = name === "propose_send" ? await proposeSend(ctx.session, args, policyState) : await proposeSwap(ctx.session, args, policyState);
        // The tool result tells the model plainly that nothing has happened yet.
        return JSON.stringify({ status: "waiting_for_the_owner_to_tap_approve", nothing_has_been_sent: true, mode: card.mode, card });
      } catch (e) {
        if (e instanceof ProposalError) return JSON.stringify({ user_error: e.message }); // friendly, spoken as is
        throw e;
      }
    }
    if (name === "propose_deposit" || name === "get_deposit_status") {
      try {
        if (name === "propose_deposit") {
          const card = await proposeDeposit(ctx.session, args);
          return JSON.stringify({ status: "waiting_for_the_owner_to_send_usdc_from_base", orbi_sent_nothing: true, estimate_near: card.lines[1], card });
        }
        const s = await depositStatus(ctx.session);
        return JSON.stringify({ state: s.state, say: s.spoken });
      } catch (e) {
        if (e instanceof BridgeError) return JSON.stringify({ user_error: e.message });
        throw e;
      }
    }
    if (name === "remember" || name === "forget") {
      if (!memoryEnabled()) return JSON.stringify({ user_error: "My memory is switched off right now." });
      try {
        if (name === "remember") {
          const { note, duplicate } = addNote(String(args.note ?? ""), ownerOf(ctx.session));
          return JSON.stringify({ saved: true, already_known: duplicate, note: note.text });
        }
        const { removed, ambiguous } = forgetNote(String(args.about ?? ""), ownerOf(ctx.session));
        if (removed.length) return JSON.stringify({ forgotten: removed[0].text });
        if (ambiguous.length) return JSON.stringify({ user_error: "That matches more than one note. Say a bit more about which one.", matches: ambiguous.map((n) => n.text) });
        return JSON.stringify({ user_error: "I don't have a note like that." });
      } catch (e) {
        if (e instanceof MemoryError || e instanceof OwnerError) return JSON.stringify({ user_error: e.message });
        throw e;
      }
    }
    if (name === "get_balances" && typeof args.contact === "string" && args.contact.trim()) {
      const c = resolveContact(args.contact, ownerOf(ctx.session));
      if (!c) return JSON.stringify({ user_error: `I don't have a contact called ${String(args.contact).trim().slice(0, 30)}.` });
      // The address stays out of the result, so it can never be read aloud.
      return JSON.stringify({ contact: c.name, balances: await allBalances(c.address) });
    }
    if (name === "get_balances") {
      if (!config.agentAccount) throw new Error("NEAR_AGENT_ACCOUNT_ID is not set");
      return JSON.stringify({ account: config.agentAccount, balances: await allBalances(config.agentAccount) });
    }
    if (name === "get_last_transaction") return JSON.stringify(await recentTransactions(ACTIVITY, Number(args.count) || 1));
    if (name === "get_yields") return JSON.stringify(await getYields(args));
    if (name === "get_prices") return JSON.stringify(await getPrices(args.symbols ?? []));
    if (name === "get_swap_quote") {
      const { routes, best, errors } = await compareRoutes(args.from_token, args.to_token, String(args.amount));
      if (!best) return JSON.stringify({ error: "No route available", details: errors });
      const usd = routes.map((r) => r.usdIn).find((v) => v !== undefined);
      const verdict = usd === undefined ? { allowed: false, reason: "USD value unknown." } : checkAction(usd, policyState);
      return JSON.stringify({
        from: args.from_token,
        to: args.to_token,
        amount: args.amount,
        routes: routes.map((r) => ({
          source: r.source,
          you_receive_estimate: r.amountOut,
          before_orbi_fee: r.amountOutBeforeFee,
          orbi_fee_percent: r.orbiFeePct,
          eta_seconds: r.etaSeconds,
          note: r.note,
        })),
        best_route: best.source,
        approx_usd_value: usd,
        policy: verdict,
        execution_enabled: false,
        route_errors: errors,
      });
    }
    return JSON.stringify({ error: `Unknown tool ${name}` });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}
