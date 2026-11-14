// What an approved action is doing right now, so the card can show its stages live. Display only: nothing here
// can start, change or stop a transaction. Labels are plain words (never addresses or keys).
export type Step = { label: string; state: "doing" | "done" | "failed" };
export type Run = { session: string; steps: Step[]; status: "running" | "done" | "failed"; at: number };

const runs = new Map<string, Run>();
const KEEP_MS = 10 * 60_000;
const MAX_RUNS = 200;

function prune(now: number) {
  for (const [id, r] of runs) if (now - r.at > KEEP_MS) runs.delete(id);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string);
}

export function startRun(id: string, session: string, now = Date.now()) {
  prune(now);
  runs.set(id, { session, steps: [], status: "running", at: now });
}

// A new step begins: the one before it is finished.
export function stepStart(id: string, label: string) {
  const r = runs.get(id);
  if (!r || r.status !== "running") return;
  for (const s of r.steps) if (s.state === "doing") s.state = "done";
  r.steps.push({ label: String(label).slice(0, 80), state: "doing" });
}

export function endRun(id: string, ok: boolean) {
  const r = runs.get(id);
  if (!r) return;
  for (const s of r.steps) if (s.state === "doing") s.state = ok ? "done" : "failed";
  r.status = ok ? "done" : "failed";
}

// Only the session that owns the action may look.
export function getRun(session: string, id: string): { status: Run["status"]; steps: Step[] } | null {
  const r = runs.get(id);
  if (!r || r.session !== session) return null;
  return { status: r.status, steps: r.steps.map((s) => ({ ...s })) };
}
