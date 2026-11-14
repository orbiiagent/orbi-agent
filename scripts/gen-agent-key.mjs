// Generates a fresh ed25519 keypair for the agent's NEAR account (offline, no network).
// Writes the secret to .env (git-ignored) and prints ONLY the public account id.
// Refuses to overwrite an existing agent key.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

if (existsSync(envPath) && readFileSync(envPath, "utf8").includes("NEAR_AGENT_PRIVATE_KEY=")) {
  console.error("An agent key already exists in .env. Refusing to overwrite it.");
  process.exit(1);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

const { privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const seed = Buffer.from(jwk.d, "base64url"); // 32 bytes
const pub = Buffer.from(jwk.x, "base64url"); // 32 bytes

const secretKey = "ed25519:" + base58(Buffer.concat([seed, pub])); // NEAR format: seed + pubkey
const publicKey = "ed25519:" + base58(pub);
const accountId = pub.toString("hex"); // implicit account id (64 hex chars)

const lines = [
  "",
  "# Agent wallet (generated locally by scripts/gen-agent-key.mjs). Never commit or share.",
  `NEAR_AGENT_ACCOUNT_ID=${accountId}`,
  `NEAR_AGENT_PUBLIC_KEY=${publicKey}`,
  `NEAR_AGENT_PRIVATE_KEY=${secretKey}`,
  "",
].join("\n");

if (!existsSync(envPath)) writeFileSync(envPath, "");
appendFileSync(envPath, lines);
chmodSync(envPath, 0o600);

console.log("Agent account created locally (not yet on-chain until it receives funds).");
console.log("Account id : " + accountId);
console.log("Public key : " + publicKey);
console.log("Secret key : saved to .env (hidden)");
