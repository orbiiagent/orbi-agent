// Deterministic spending policy. The model never decides whether an action is allowed: this code does.
import { config } from "./config.ts";

export type PolicyState = { dayKey: string; spentUsd: number; actions?: number };

export function newPolicyState(now = new Date()): PolicyState {
  return { dayKey: now.toISOString().slice(0, 10), spentUsd: 0, actions: 0 };
}

export type Verdict = { allowed: boolean; reason: string };

export function checkAction(
  usd: number,
  state: PolicyState,
  limits = { maxActionUsd: config.maxActionUsd, maxDailyUsd: config.maxDailyUsd },
  now = new Date()
): Verdict {
  if (!Number.isFinite(usd) || usd <= 0) return { allowed: false, reason: "Could not determine the USD value of this action." };
  const day = now.toISOString().slice(0, 10);
  if (state.dayKey !== day) {
    state.dayKey = day;
    state.spentUsd = 0;
    state.actions = 0;
  }
  // Each real action costs network fees whatever its size, so a shared demo also caps how MANY actions run in a day.
  if (config.maxLiveActionsPerDay > 0 && (state.actions ?? 0) >= config.maxLiveActionsPerDay) {
    return { allowed: false, reason: `The demo has reached its limit of ${config.maxLiveActionsPerDay} real actions for today. Please try again tomorrow.` };
  }
  if (usd > limits.maxActionUsd) {
    return { allowed: false, reason: `Above the per-action limit of $${limits.maxActionUsd}.` };
  }
  if (state.spentUsd + usd > limits.maxDailyUsd) {
    return { allowed: false, reason: `Would exceed the daily limit of $${limits.maxDailyUsd}.` };
  }
  return { allowed: true, reason: "Within limits." };
}

export function recordSpend(usd: number, state: PolicyState) {
  state.spentUsd += usd;
  state.actions = (state.actions ?? 0) + 1;
}
