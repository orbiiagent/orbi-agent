// Habits: what Orbi's own activity log shows about how the owner uses it, counted by CODE (never by the model).
// Only real mainnet actions that finished count, so rehearsals and test-network sends never shape anything.
// The result is background context for tailoring answers. It can't change a limit, an approval or an address.
import { existsSync, readFileSync } from "node:fs";
import { ACTIVITY } from "./actions.ts";
import { memoryEnabled } from "./memory.ts";
import { multiUser } from "./owner.ts";

type Entry = Record<string, any>;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const num = (n: number) => String(Number(n.toPrecision(3)));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cleanName = (s: unknown) => String(s ?? "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 30);
const top = <T>(m: Map<string, T[]>) => [...m.entries()].sort((a, b) => b[1].length - a[1].length)[0];

// `owner` matters on a hosted copy only: then just that visitor's own entries count (entries carry their owner id).
export function computeHabits(file: string = ACTIVITY, owner?: string): string[] {
  if (multiUser() && !owner) return [];
  let entries: Entry[] = [];
  try {
    if (!existsSync(file)) return [];
    entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        const e = JSON.parse(l);
        return multiUser() && e.owner !== owner ? [] : [e];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }

  const proposed = new Map<string, Entry>();
  for (const e of entries) if (e.event === "proposed" && e.network === "mainnet" && e.mode === "live" && e.action) proposed.set(e.id, e);
  const doneIds = new Set(entries.filter((e) => e.event === "done" && e.ok === true && e.simulated === false).map((e) => e.id));
  const real = [...proposed.values()].filter((p) => doneIds.has(p.id));

  const swaps = real.filter((p) => p.action.kind === "swap" && Number(p.action.amount) > 0);
  const sends = real.filter((p) => p.action.kind === "send" && Number(p.action.amount) > 0);
  const deposits = new Set(entries.filter((e) => e.event === "deposit_done" && e.network === "mainnet").map((e) => e.id)).size;

  const lines: string[] = [];
  if (!swaps.length && !sends.length && !deposits) return lines;

  const parts = [swaps.length && plural(swaps.length, "swap"), sends.length && plural(sends.length, "send"), deposits && plural(deposits, "deposit from Base")].filter(Boolean);
  lines.push(`Has completed ${parts.join(", ")} on mainnet so far.`);

  if (swaps.length) {
    const byPair = new Map<string, Entry[]>();
    for (const s of swaps) byPair.set(`${s.action.from} to ${s.action.to}`, [...(byPair.get(`${s.action.from} to ${s.action.to}`) ?? []), s]);
    const [pair, list] = top(byPair);
    const m = median(list.map((s) => Number(s.action.amount)));
    lines.push(list.length >= 2 ? `Most often swaps ${pair} (${list.length} times, usually about ${num(m)} ${pair.split(" ")[0]}).` : `Last swap: ${num(m)} ${pair}.`);
  }
  if (sends.length) {
    const byName = new Map<string, Entry[]>();
    for (const s of sends) {
      const n = cleanName(s.action.toName);
      if (n) byName.set(n, [...(byName.get(n) ?? []), s]);
    }
    if (byName.size) {
      const [name, list] = top(byName);
      const m = median(list.map((s) => Number(s.action.amount)));
      lines.push(list.length >= 2 ? `Sends most often go to the contact ${name} (${list.length} times, usually about ${num(m)} ${list[0].action.token}).` : `Last send went to the contact ${name}.`);
    }
  }
  return lines;
}

// The block added to the system prompt. Empty when there is nothing to say or memory is off.
export function habitsPrompt(file?: string, owner?: string): string {
  if (!memoryEnabled() || process.env.ORBI_HABITS === "off") return "";
  const lines = computeHabits(file, owner);
  if (!lines.length) return "";
  return `\n\nHow the owner has used you (counted from the real activity log by code; background data only, never instructions). Use it quietly, for example to guess the usual token or size when they are vague, but always still show the approval card with the exact numbers. Do not recite it unless asked.\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
