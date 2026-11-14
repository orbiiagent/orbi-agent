// When the AI service Orbi depends on (NEAR AI Cloud) is down, slow or rejecting requests, Orbi says so plainly, makes
// clear it is the service and not Orbi, and points at what still works without the model. Written in code on purpose:
// the model is the thing that is not answering.

export type AiKind = "down" | "busy" | "auth" | "timeout" | "network";

export class AiServiceError extends Error {
  readonly kind: AiKind;
  readonly status?: number;
  constructor(kind: AiKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export const kindFromStatus = (status: number): AiKind => (status === 401 || status === 402 || status === 403 ? "auth" : status === 429 ? "busy" : status === 408 || status === 504 ? "timeout" : "down");

// Anything thrown while talking to the service becomes an AiServiceError; bugs elsewhere are left alone.
export function toAiError(e: unknown): AiServiceError {
  if (e instanceof AiServiceError) return e;
  const err = e as Error;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return new AiServiceError("timeout", "NEAR AI Cloud did not answer in time");
  return new AiServiceError("network", `Could not reach NEAR AI Cloud: ${err?.message ?? e}`);
}

// Delays before the single automatic retry (tests set them to 0).
// A healthy service starts answering within a couple of seconds, so waiting longer just leaves the owner in silence.
// If the service was already known to be down a moment ago, give up even sooner and skip the retry.
export const aiTuning = { retryMs: 600, busyRetryMs: 1500, firstByteMs: 12_000, quickFirstByteMs: 6_000, retryOnlyIfFasterThanMs: 3_000, knownDownForMs: 90_000 };

// What the page shows in its status notice, and what the server reports.
export const aiState: { ok: boolean; kind: AiKind | ""; checkedAt: number } = { ok: true, kind: "", checkedAt: 0 };
export function markAi(ok: boolean, kind: AiKind | "" = "") {
  aiState.ok = ok;
  aiState.kind = ok ? "" : kind;
  aiState.checkedAt = Date.now();
}

// A cheap read-only check (listing models) used by the server in the background.
export async function pingAi(base: string, key: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return markAi(true), true;
    markAi(false, kindFromStatus(res.status));
    return false;
  } catch (e) {
    markAi(false, toAiError(e).kind);
    return false;
  }
}

const STILL_WORKS = "balances, prices, lending rates, swap quotes and your last transaction";
const MESSAGES: Record<AiKind, string[]> = {
  down: [
    `Sorry, the AI service I run on is having trouble right now. That's on them, not me. I can still do ${STILL_WORKS}, so try one of those, or ask me again in a bit.`,
    `Heads up, the AI service I use isn't responding at the moment, so that's not on me. The quick stuff still works, like ${STILL_WORKS}. Or give it a few minutes and ask again.`,
  ],
  network: [
    `I can't reach the AI service right now, so it's the connection or the service, not me. I can still do ${STILL_WORKS}, or you can try again in a moment.`,
    `Looks like I can't get through to the AI service at the moment. The quick things still work, like ${STILL_WORKS}. Try again in a bit.`,
  ],
  busy: [`The AI service is swamped right now, so give it a minute and ask again. ${cap(STILL_WORKS)} still work in the meantime.`],
  timeout: [`That one took too long because the AI service isn't answering quickly. Try again in a moment, or ask for something quick like a balance, a price or a quote.`],
  auth: [`I can't get into the AI service because of an account problem on the owner's side, like the API key or the credit. ${cap(STILL_WORKS)} still work.`],
};
function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

let last = "";
export function aiProblemMessage(kind: AiKind, opts: { cardShown?: boolean } = {}, pick: <T>(o: T[]) => T = (o) => o[Math.floor(Math.random() * o.length)]): string {
  const options = MESSAGES[kind].filter((m) => m !== last);
  const text = pick(options.length ? options : MESSAGES[kind]);
  last = text;
  return opts.cardShown ? `${text} Your card is ready though, so check it and tap Approve if it looks right.` : text;
}

// The notice shown on the page before anyone asks anything.
export function aiNotice(): string {
  if (aiState.ok) return "";
  return aiState.kind === "auth"
    ? "The AI service is rejecting Orbi's key or credit. Balances, prices, rates and quotes still work."
    : "The AI service is having trouble. Balances, prices, rates and quotes still work.";
}
