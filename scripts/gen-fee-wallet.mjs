// Generates a fresh ed25519 keypair for Orbi's FEE RECIPIENT account (offline, no network).
// The SECRET goes to .secrets/orbi-fee-wallet.json (git-ignored, mode 600), NOT to .env,
// because the running agent never needs it. Only the public account id is added to .env.
// Refuses to overwrite an existing fee wallet or recipient.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const secretDir = join(root, ".secrets");
const secretPath = join(secretDir, "orbi-fee-wallet.json");

if (existsSync(secretPath)) {
  console.error("A fee wallet already exists in .secrets/. Refusing to overwrite it.");
  process.exit(1);
}
if (existsSync(envPath) && /^ORBI_FEE_RECIPIENT=\S+/m.test(readFileSync(envPath, "utf8"))) {
  console.error("ORBI_FEE_RECIPIENT is already set in .env. Refusing to replace it.");
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
const seed = Buffer.from(jwk.d, "base64url");
const pub = Buffer.from(jwk.x, "base64url");
const accountId = pub.toString("hex");

mkdirSync(secretDir, { recursive: true });
writeFileSync(
  secretPath,
  JSON.stringify(
    {
      purpose: "Orbi fee recipient wallet. Back this up in a password manager, then keep it offline.",
      account_id: accountId,
      public_key: "ed25519:" + base58(pub),
      private_key: "ed25519:" + base58(Buffer.concat([seed, pub])),
    },
    null,
    2
  ) + "\n"
);
chmodSync(secretPath, 0o600);
chmodSync(secretDir, 0o700);

if (!existsSync(envPath)) writeFileSync(envPath, "");
const env = readFileSync(envPath, "utf8");
if (/^ORBI_FEE_RECIPIENT=\s*$/m.test(env)) {
  writeFileSync(envPath, env.replace(/^ORBI_FEE_RECIPIENT=\s*$/m, `ORBI_FEE_RECIPIENT=${accountId}`));
} else {
  appendFileSync(envPath, `\n# Orbi fee recipient (public address only)\nORBI_FEE_RECIPIENT=${accountId}\nORBI_FEE_PER_MILLE=1\n`);
}
chmodSync(envPath, 0o600);

console.log("Fee wallet created locally (not on-chain until it receives funds).");
console.log("Account id : " + accountId);
console.log("Secret key : saved to .secrets/orbi-fee-wallet.json (hidden)");
console.log("ORBI_FEE_RECIPIENT set in .env");
