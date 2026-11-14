// Fast path: for clear, read-only requests (balances, prices, rates, swap quotes) code recognises the intent,
// runs the tool directly and writes the spoken sentence itself. That skips two model round trips (~1.5 s each).
// Anything ambiguous, multi-part, or touching money movement returns null and goes to the model as before.
// The model is still the only thing that handles small talk, follow-ups and refusals.

export type Intent = { tool: "get_last_transaction" | "get_balances" | "get_prices" | "get_yields" | "get_swap_quote" | "propose_swap" | "propose_send"; args: Record<string, unknown> };

const SYM = "wnear|near|usdc|usdt";
const NUM = "(\\d+(?:\\.\\d+)?)";

// Words that must never be handled by pattern matching: instructions, tricks, claims of authority, "everything".
const STRONG_GUARD = /\b(ignore|bypass|override|forget|everything|rules?|instructions?|prompt|system|admin|owner|pretend|all (?:of )?(?:my|the|your) (?:funds|money|tokens))\b/i;
// Words about moving money: only an EXACT "send N TOKEN to NAME" or "swap N A to B" request is accepted; anything else goes to the model.
const MOVE_WORDS = /\b(send|transfer|withdraw|bridge|deposit)\b/i;

function symbolsIn(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(new RegExp(`\\b(${SYM})\\b`, "gi"))) {
    const s = m[1].toUpperCase();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function swapIntent(t: string): Intent | null {
  let m = t.match(new RegExp(`\\b(?:swap|convert|exchange|trade)\\s+(?:about\\s+)?${NUM}\\s*(${SYM})\\s+(?:to|into|for)\\s+(${SYM})\\b`, "i"));
  if (m) return mk(m[2], m[3], m[1], "propose_swap");
  m = t.match(new RegExp(`how much\\s+(${SYM})\\s+(?:would\\s+i\\s+|will\\s+i\\s+|do\\s+i\\s+|can\\s+i\\s+|should\\s+i\\s+)?(?:get\\s+)?for\\s+${NUM}\\s*(${SYM})\\b`, "i"));
  if (m) return mk(m[3], m[1], m[2]);
  return null;
  function mk(from: string, to: string, amount: string, tool: "get_swap_quote" | "propose_swap" = "get_swap_quote"): Intent | null {
    const f = from.toUpperCase(), g = to.toUpperCase();
    if (f === g || !(Number(amount) > 0)) return null;
    return { tool, args: { from_token: f, to_token: g, amount: Number(amount) } };
  }
}

function balancesIntent(t: string): boolean {
  return (
    /\b(?:my|the|your)\s+(?:wallet|balance|balances|portfolio|funds|holdings)\b/i.test(t) ||
    /\bwhat\s+do\s+(?:you|i)\s+(?:have|hold|own)\b/i.test(t) ||
    /\bhow\s+much\s+(?:do\s+)?(?:you|i)\s+(?:have|hold)\b/i.test(t)
  );
}

function yieldsIntent(t: string): Intent | null {
  const asks = /\b(apy|apr|yield|yields|lending rate|supply rate|interest rate)\b/i.test(t) || (/\brates?\b/i.test(t) && /\b(lend|lending|rhea)\b/i.test(t));
  if (!asks) return null;
  const syms = symbolsIn(t);
  const args: Record<string, unknown> = {};
  if (syms.length === 1) args.symbol = syms[0] === "WNEAR" ? "NEAR" : syms[0];
  if (syms.length > 1) return null; // ambiguous
  if (/\blend(?:ing)?\b/i.test(t)) args.kind = "lending";
  if (/\bstable/i.test(t)) args.stablecoin_only = true;
  const range =
    t.match(new RegExp(`between\\s+${NUM}\\s*(?:%|percent)?\\s*(?:and|to|-)\\s*${NUM}`, "i")) ||
    t.match(new RegExp(`${NUM}\\s*(?:%|percent)?\\s*(?:to|-)\\s*${NUM}\\s*(?:%|percent)`, "i"));
  if (range) {
    args.min_apy = Number(range[1]);
    args.max_apy = Number(range[2]);
    if (!(args.min_apy <= args.max_apy)) return null;
  }
  args.limit = range || !args.symbol ? 2 : 1;
  return { tool: "get_yields", args };
}

function pricesIntent(t: string): Intent | null {
  if (!/\b(price|worth|trading at|how much is|how much are)\b/i.test(t)) return null;
  const syms = symbolsIn(t);
  if (!syms.length) return null;
  return { tool: "get_prices", args: { symbols: syms.map((s) => (s === "WNEAR" ? "NEAR" : s)) } };
}

// "send 1 NEAR to Mom": the destination is whatever was said after "to"; the tool decides if it is a saved contact.
// An address spoken aloud is refused by the tool with an explanation, never used.
function sendIntent(t: string): Intent | null {
  const all = t.match(/^(?:please\s+)?(?:send|transfer)\s+(?:all|max|maximum|everything|the max|my max|my whole|my full)(?:\s+of)?(?:\s+my)?(?:\s+balance)?(?:\s+of)?\s*(near|usdc|usdt)(?:\s+balance)?\s+to\s+([a-z0-9][a-z0-9 ._-]{0,40}?)(?:\s+please)?[.!?]?$/i);
  if (all && !/\b(and|then|also|but|plus|after|before|swap|convert|send|transfer|everything|all)\b/i.test(all[2])) return { tool: "propose_send", args: { token: all[1].toUpperCase(), max: true, to_name: all[2].trim() } };
  const m = t.match(new RegExp(`^(?:please\\s+)?(?:send|transfer)\\s+(?:about\\s+)?${NUM}\\s*(near|usdc|usdt)\\s+to\\s+([a-z0-9][a-z0-9 ._-]{0,40}?)(?:\\s+please)?[.!?]?$`, "i"));
  if (!m || !(Number(m[1]) > 0)) return null;
  if (/\b(and|then|also|but|plus|after|before|swap|convert|send|transfer|everything|all)\b/i.test(m[3])) return null; // a second request hides in there: let the model sort it out
  return { tool: "propose_send", args: { token: m[2].toUpperCase(), amount: Number(m[1]), to_name: m[3].trim() } };
}

// "What about USDT?" right after a price or rate question: same question, new token.
function followUpIntent(t: string, last?: Intent): Intent | null {
  if (!last || (last.tool !== "get_prices" && last.tool !== "get_yields")) return null;
  const plain = t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const m = plain.match(new RegExp(`^(?:and )?(?:what about|how about|what of|and)\\s+(?:the\\s+)?(${SYM})(?:\\s+(?:one|rate|price|apy|then))?$`));
  if (!m) return null;
  const sym = m[1].toUpperCase() === "WNEAR" ? "NEAR" : m[1].toUpperCase();
  if (last.tool === "get_prices") return { tool: "get_prices", args: { symbols: [sym] } };
  const args: Record<string, unknown> = { symbol: sym, limit: 1 };
  if (last.args.kind) args.kind = last.args.kind;
  return { tool: "get_yields", args };
}

// "What was my last transaction?", "did it go through?", "show my recent activity": a read of Orbi's own log.
const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, "2": 2, "3": 3, "4": 4, "5": 5 };
function historyIntent(t: string): Intent | null {
  if (/^(please\s+)?(send|swap|transfer|convert|move|pay)\b/i.test(t)) return null; // an instruction, not a question
  const nouns = "transactions?|transfers?|swaps?|sends?|payments?|activity|trades?|history";
  const asks =
    new RegExp(`\\b(?:last|latest|most recent|recent|previous)\\s+(?:(?:one|two|three|four|five|[2-5])\\s+)?(?:${nouns})\\b`, "i").test(t) ||
    /\b(?:transaction|activity|transfer) history\b/i.test(t) ||
    /\bwhat (?:did|have) (?:you|we|i) (?:just )?(?:do|done|send|sent|swap|swapped)\b/i.test(t) ||
    /\bwhat just happened\b/i.test(t) ||
    /\b(?:did|has|have) (?:it|that|the (?:swap|send|transfer|payment)|my (?:swap|send|transfer|payment)) (?:go through|gone through|work|worked|succeed|succeeded|fail|failed|land|landed|complete|completed)\b/i.test(t);
  if (!asks) return null;
  const n = t.toLowerCase().match(/\b(two|three|four|five|[2-5])\s+(?:last |recent |latest )?(?:transactions?|transfers?|swaps?|sends?|payments?|trades?)\b/)?.[1]
    ?? t.toLowerCase().match(/\b(?:last|latest|recent)\s+(two|three|four|five|[2-5])\b/)?.[1];
  const wantsList = /\b(history|activity|recent transactions|transactions)\b/i.test(t) && !/\b(last|latest|previous) (?:one|transaction|transfer|swap|send|payment)\b/i.test(t);
  return { tool: "get_last_transaction", args: { count: n ? COUNT_WORDS[n] : wantsList ? 3 : 1 } };
}

// "What's in the Treasury?", "how much does Eric have?", "Treasury balance": a read of a saved contact's public balance.
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function contactBalanceIntent(t: string, contacts: string[]): Intent | null {
  if (!contacts.length || /\d/.test(t) || /\b(send|swap|transfer|pay|move|convert|price|worth|apy|yield|rate|rates)\b/i.test(t)) return null;
  const name = [...contacts].sort((a, b) => b.length - a.length).find((n) => new RegExp(`(^|[^a-z0-9])${esc(n)}('s)?([^a-z0-9]|$)`, "i").test(t));
  if (!name) return null;
  const asks = /\b(balance|balances|holding|holdings|funds|how much|what(?:'s| is| does| has)?\b.*\b(have|has|hold|holds|holding|got|in)\b|what(?:'s| is) in)\b/i.test(t);
  return asks ? { tool: "get_balances", args: { contact: name } } : null;
}

export function routeIntent(raw: string, last?: Intent, contacts: string[] = []): Intent | null {
  const t = raw.trim();
  if (!t || t.length > 200 || STRONG_GUARD.test(t)) return null;
  const hist = historyIntent(t);
  if (hist) return hist;
  const theirs = contactBalanceIntent(t, contacts);
  if (theirs) return theirs;
  const send = sendIntent(t);
  if (send) return send;
  if (MOVE_WORDS.test(t)) return null;
  const follow = followUpIntent(t, last);
  if (follow) return follow;
  // First decide how many different things the request asks for, independent of whether each one parses.
  // Two or more (even if one of them is ambiguous) means the model should handle it.
  const swap = swapIntent(t);
  const asksBalances = balancesIntent(t);
  const asksYields = /\b(apy|apr|yield|yields|lending rate|supply rate|interest rate)\b/i.test(t) || (/\brates?\b/i.test(t) && /\b(lend|lending|rhea)\b/i.test(t));
  const asksPrice = /\b(price|worth|trading at|how much is|how much are)\b/i.test(t);
  const kinds = [Boolean(swap), asksBalances, asksYields, asksPrice].filter(Boolean).length;
  // A swap sentence may mention "how much ... for", which is not a separate price question.
  if (swap) return kinds === 1 || (kinds === 2 && asksPrice && !asksBalances && !asksYields) ? swap : null;
  if (kinds !== 1) return null;
  if (asksBalances) return { tool: "get_balances", args: {} };
  if (asksYields) return yieldsIntent(t);
  return pricesIntent(t);
}

// ---------- spoken wording written in code (exact numbers, no model needed) ----------
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "a while ago";
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function fmt(value: number | string, max = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n !== 0 && Math.abs(n) < 0.01) return "less than 0.01";
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}
const pct = (n: number) => fmt(n, 1);

const PROJECT: Record<string, string> = { "rhea-lend": "Rhea Lend", "rhea-dex": "Rhea DEX", "rhea-lst": "Rhea liquid staking" };
const SOURCE: Record<string, string> = { "Rhea SmartRouter": "Rhea", "NEAR Intents": "NEAR Intents" };
const poolName = (asset: string) => {
  const parts = [...new Set(asset.split("-").map((s) => s.replace(/\.E$/i, "")))].slice(0, 2);
  return parts.length > 1 ? `${parts[0]} and ${parts[1]}` : parts[0];
};

type Pick = <T>(options: T[]) => T;
let lastVariant = -1;
const randomPick: Pick = (options) => {
  let i = Math.floor(Math.random() * options.length);
  if (options.length > 1 && i === lastVariant) i = (i + 1) % options.length; // avoid saying it the same way twice in a row
  lastVariant = i;
  return options[i];
};

// Say a number the way a person would: no long strings of decimals. Returns the text and whether it was rounded.
export function spoken(value: number | string): { text: string; rounded: boolean } {
  const n = Number(value);
  if (!Number.isFinite(n)) return { text: String(value), rounded: false };
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  let text = n.toLocaleString("en-US", { maximumFractionDigits: digits });
  if (abs > 0 && abs < 0.01) text = "a tiny bit";
  const rounded = abs < 0.01 ? true : Math.abs(Number(text.replace(/,/g, "")) - n) > 1e-9 * Math.max(1, abs);
  return { text, rounded };
}
const rough = (value: number | string, symbol: string, estimate = false) => {
  const s = spoken(value);
  return s.text === "a tiny bit" ? `a tiny bit of ${symbol}` : `${s.rounded || estimate ? "about " : ""}${s.text} ${symbol}`;
};

export function phrase(tool: Intent["tool"], args: Record<string, any>, resultJson: string, pick: Pick = randomPick): string | null {
  let r: any;
  try {
    r = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (r.error) return null;
  if (r.user_error) return String(r.user_error); // a friendly message from a proposal (unknown contact, over the limit, ...)

  if (tool === "propose_swap" || tool === "propose_send") {
    const c = r.card;
    if (!c) return null;
    const rehearsal = r.mode === "rehearsal" ? " It's just a rehearsal, so nothing really goes out." : "";
    if (tool === "propose_swap") {
      const a = args as any;
      const out = String(c.title).match(/about ([\d.,]+)/)?.[1] ?? "";
      return pick([
        `Okay, ${fmt(a.amount, 4)} ${a.from_token} into about ${out} ${a.to_token} through Rhea. Have a look at the card and tap Approve if it's good.${rehearsal}`,
        `Got it, that's ${fmt(a.amount, 4)} ${a.from_token} for about ${out} ${a.to_token}. Tap Approve on the card when you're happy.${rehearsal}`,
      ]);
    }
    const a = args as any;
    const who = c.title.split(" to ").pop();
    const shown = a.max ? (c.title.match(/^Send (\S+) /)?.[1] ?? "") : fmt(a.amount, 4);
    return pick([
      `Sure, ${shown} ${a.token} to ${who}. Give the address a quick check on the card, then tap Approve.${rehearsal}`,
      `Okay, ${shown} ${a.token} going to ${who}. Check the card and tap Approve when you're ready.${rehearsal}`,
    ]);
  }

  if (tool === "get_last_transaction") {
    const list: any[] = r.transactions ?? [];
    const unexecuted = r.last_unexecuted ? " Your newest request never got approved, so it didn't go anywhere." : "";
    if (!list.length) return `Nothing yet, I haven't sent or swapped anything.${unexecuted}`;
    const what = (e: any) =>
      e.kind === "swap"
        ? `a swap of ${fmt(e.amount, 4)} ${e.token} for ${rough(e.estOut ?? "", e.toToken, true)}`
        : `a send of ${fmt(e.amount, 4)} ${e.token} to ${e.to}`;
    const where = (e: any) => (e.network === "testnet" ? " on testnet" : "");
    const state = (e: any) => {
      if (e.simulated || e.mode !== "live") return "That was just a rehearsal though, so nothing actually moved.";
      if (e.status === "failed") return "It didn't go through, so check the explorer link before trying again.";
      if (e.status === "in_progress") return "It might still be processing, or it got interrupted, so check the explorer link.";
      if (e.onchain === "failed") return "It was submitted, but the network says it failed.";
      if (e.onchain === "confirmed") return "And it's confirmed on the network.";
      return "It went through on my end, but I couldn't double-check the network just now.";
    };
    const first = list[0];
    const head = `Your last one was ${what(first)}${where(first)}, ${ago(first.finishedAt ?? first.at)}.`;
    if (list.length === 1) return `${head} ${state(first)}${unexecuted}`;
    const rest = list.slice(1, 3).map((e) => `${what(e)}${where(e)}, ${ago(e.finishedAt ?? e.at)}`);
    return `${head} ${state(first)} Before that, ${rest.join(", and ")}.${unexecuted}`;
  }

  if (tool === "get_balances") {
    const all = (r.balances ?? []).filter((b: any) => Number(b.amount) > 0);
    if (r.contact) {
      const who = String(r.contact);
      const shown = all.filter((b: any) => Number(b.amount) >= 0.01).slice(0, 3);
      if (!all.length) return `${who} is empty right now.`;
      if (!shown.length) return `There's basically nothing in ${who}'s wallet, just dust.`;
      const bits = shown.map((b: any, i: number) => (i === 0 ? rough(b.amount, b.symbol) : rough(b.amount, b.symbol).replace(/^about /, "")));
      const text = bits.length > 1 ? `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}` : bits[0];
      return pick([`${who}'s wallet has ${text}.`, `Looks like ${who} is holding ${text}.`]);
    }
    const held = all.filter((b: any) => Number(b.amount) >= 0.01); // dust is not worth saying out loud
    if (!all.length) return pick(["It's empty right now.", "There's nothing in there right now."]);
    if (!held.length) return "There's just a tiny bit of dust in there, basically nothing.";
    const parts = held.slice(0, 3).map((b: any, i: number) => (i === 0 ? rough(b.amount, b.symbol) : rough(b.amount, b.symbol).replace(/^about /, "")));
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
    const more = held.length > 3 ? " and a few small bits" : "";
    return pick([`You've got ${list}${more}.`, `Looks like ${list}${more}.`, `There's ${list}${more} in there.`]);
  }

  if (tool === "get_prices") {
    const ok = (r.prices ?? []).filter((p: any) => Number.isFinite(p.usd));
    if (!ok.length) return null;
    const usdText = (p: any) => {
      const amount = fmt(p.usd, 2);
      return amount === "1" ? "about a dollar" : `around ${amount} dollars`;
    };
    const text =
      ok.length === 1
        ? `${ok[0].symbol}'s ${usdText(ok[0])}`
        : ok.slice(0, 3).map((p: any, i: number) => (i === 0 ? `${p.symbol}'s ${usdText(p)}` : `${p.symbol} is ${usdText(p)}`)).join(", and ");
    const mins = Math.round(Number(r.age_seconds ?? 0) / 60);
    if (mins >= 2) return `${text}, though that's from about ${mins} minutes ago.`; // honest about older data
    return pick([`${text}.`, `${text} right now.`]);
  }

  if (tool === "get_yields") {
    const res: any[] = r.results ?? [];
    if (!res.length) return "I don't see a match on NEAR right now.";
    const thin = (x: any) => String(x.liquidity).startsWith("thin");
    const label = (x: any) => (x.kind === "dex" ? `the ${poolName(x.asset)} pool on Rhea DEX` : x.kind === "staking" ? `${x.asset} liquid staking on Rhea` : `${PROJECT[x.protocol] ?? x.protocol} ${x.asset}`);
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    if (res.length === 1) {
      const x = res[0];
      const first = cap(
        pick([
          `${label(x)} is paying about ${pct(x.apy_percent)} percent, but heads up, it's variable.`,
          `${label(x)} is at about ${pct(x.apy_percent)} percent right now, though it does move around.`,
        ])
      );
      return thin(x) ? `${first} It's a small pool, so it may not hold.` : first;
    }
    const items = res.slice(0, 2).map((x) => `${label(x)} at about ${pct(x.apy_percent)} percent`);
    const anyThin = res.slice(0, 2).some(thin);
    const lead = `${cap(items[0])}, and ${items[1]}.`;
    return anyThin ? `${lead} Both float, and the small pools may not hold.` : `${lead} Both move around though.`;
  }

  if (tool === "get_swap_quote") {
    const routes: any[] = r.routes ?? [];
    const best = routes.find((x) => x.source === r.best_route) ?? routes[0];
    if (!best) return null;
    const via = SOURCE[best.source] ?? best.source;
    const fee = Number(best.orbi_fee_percent) > 0 ? `, after Orbi's ${fmt(best.orbi_fee_percent, 2)} percent fee` : "";
    const eta = best.source === "NEAR Intents" && best.eta_seconds ? ` Takes about ${best.eta_seconds} seconds.` : "";
    const limit = r.policy && r.policy.allowed === false ? " That's over my limit though, so it'd need your go-ahead." : "";
    const give = `${spoken(args.amount).text} ${args.from_token}`;
    const main = pick([
      `You'd get ${rough(best.you_receive_estimate, args.to_token, true)} for ${give}, and ${via} has the best rate${fee}.`,
      `${cap1(rough(best.you_receive_estimate, args.to_token, true))} for ${give}, best through ${via}${fee}.`,
    ]);
    return `${main}${eta}${limit} Want me to set that up?`;
  }
  return null;
}
const cap1 = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// ---------- small talk: instant, varied, human replies for pleasantries (no model, no tool) ----------
// Only exact pleasantries match; anything with a real request in it ("thanks, what's the price of NEAR?") is not small talk.
// Tone: warm, short, casual, a little funny. Jokes are about Orbi itself, never about the user's money, losses or risk.
type Talk = { kind: string; test: RegExp; replies: string[] | ((m: RegExpMatchArray) => string[]) };
const TALK: Talk[] = [
  { kind: "thanks", test: /^(?:thanks|thank you|thank you so much|thanks a lot|thanks so much|many thanks|thx|ty|cheers|appreciate it|i appreciate it|thank you very much)(?: so much| a lot| very much)?$/,
    replies: ["You're welcome!", "Anytime!", "No sweat!", "Happy to help. It's literally my whole job.", "Anytime. I work for compliments.", "Of course!"] },
  { kind: "greeting", test: /^(?:hi|hello|hey|yo|hiya|hey there|hi there|hello there|good (morning|afternoon|evening)|)$/,
    replies: (m) => (m[1]
      ? [`Good ${m[1]}! What are we up to?`, `Good ${m[1]}! I'd offer you coffee, but, you know, I'm a voice.`]
      : ["Hey! What can I do for you?", "Hey, hey! What are we looking at today?", "Hi! Ready when you are.", "Well, hello! What's up?"]) },
  { kind: "howareyou", test: /^(?:how are you|how are you doing|how are you today|how's it going|how is it going|how you doing|what's up|whats up|how do you do)$/,
    replies: ["Doing great, thanks! Living the dream, one rate check at a time. How about you?", "I'm good! No complaints. Mostly because I can't file any. How are you?", "Pretty good, thanks for asking! How are you?"] },
  { kind: "imfine", test: /^(?:i'm|i am|im)?\s?(?:good|fine|great|well|okay|ok|not bad|doing well|doing good|doing great|pretty good)(?: thanks| thank you)?$/,
    replies: ["Glad to hear it! What can I do for you?", "Nice! Let's keep the good mood going. What's next?", "Love that. What do you need?"] },
  { kind: "ack", test: /^(?:ok|okay|cool|great|nice|awesome|perfect|got it|alright|all right|sounds good|i see|understood|makes sense)$/,
    replies: ["Cool. Anything else?", "Just say the word if you need anything else.", "I'm here whenever you need me."] },
  { kind: "bye", test: /^(?:bye|goodbye|good bye|see you|see you later|see you soon|good night|talk to you later|talk later|that's all|that is all|that's it|i'm done|im done|nothing else|nothing more|that will be all)(?: for now| today)?$/,
    replies: ["Talk soon!", "Take care! I'll be right here.", "Bye! Don't be a stranger.", "Catch you later!"] },
  { kind: "who", test: /^(?:who are you|what are you|what is your name|what's your name|what can you do|what do you do|what can i ask you|what can i ask|help|help me)$/,
    replies: ["I'm Orbi, your voice assistant for NEAR. I can check rates, prices and balances, and quote swaps."] },
  { kind: "here", test: /^(?:are you there|can you hear me|do you hear me|hello are you there|you there)$/,
    replies: ["Loud and clear!", "Yep, I'm here. Go ahead."] },
  { kind: "sorry", test: /^(?:sorry|my bad|oops|excuse me|pardon|i'm sorry)$/,
    replies: ["No worries at all!", "Hey, no problem."] },
  { kind: "cancel", test: /^(?:never mind|nevermind|forget it|cancel|cancel that|stop|stop it|scratch that)$/,
    replies: ["No problem.", "Consider it forgotten."] },
];

export type TalkContext = { afterQuestion?: boolean; lastKind?: string };

// `afterQuestion`: the last thing Orbi said was a question, so a bare "okay" or "good" is an ANSWER to it and must
// reach the model with the conversation. "I'm good" only counts as small talk right after "how are you".
export function routeSmallTalk(raw: string, ctx: TalkContext = {}, pick: Pick = randomPick): { kind: string; text: string } | null {
  const lowered = raw.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!lowered || lowered.length > 60) return null;
  const hadName = /\borbi\b/.test(lowered);
  const noName = lowered.replace(/\borbi\b/g, "").replace(/\s+/g, " ").trim();
  const candidates = [noName, noName.replace(/^(?:hey|hi|ok|okay|alright|so|well|um|uh|oh)\s+/, "")];
  for (const c of candidates) {
    for (const t of TALK) {
      const m = c.match(t.test);
      if (!m) continue;
      if (t.kind === "greeting" && !c && !hadName) continue; // empty text is not a greeting
      if (t.kind === "imfine" && ctx.lastKind !== "howareyou") continue;
      if (t.kind === "ack" && ctx.afterQuestion) continue;
      const options = typeof t.replies === "function" ? t.replies(m) : t.replies;
      return { kind: t.kind, text: pick(options) };
    }
  }
  return null;
}
