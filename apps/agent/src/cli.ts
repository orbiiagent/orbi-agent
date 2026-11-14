// Text chat with Orbi: node --env-file=.env apps/agent/src/cli.ts
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "./config.ts";
import { Orbi } from "./agent.ts";

if (!config.nearAiKey) {
  console.error("NEAR_AI_API_KEY is missing from .env");
  process.exit(1);
}
console.log(`Orbi (${config.model}). Agent account: ${config.agentAccount || "not set"}`);
console.log(
  config.feeRecipient
    ? `Orbi routing fee: ${config.feePerMille / 10}% to ${config.feeRecipient}`
    : "Orbi routing fee: off (set ORBI_FEE_RECIPIENT to enable)"
);
console.log('Type a message, or "exit".\n');

const orbi = new Orbi();
const rl = createInterface({ input: stdin, output: stdout });
while (true) {
  const line = (await rl.question("you > ")).trim();
  if (!line) continue;
  if (line === "exit") break;
  try {
    console.log(`orbi > ${await orbi.say(line)}\n`);
  } catch (e) {
    console.log(`error > ${(e as Error).message}\n`);
  }
}
rl.close();
