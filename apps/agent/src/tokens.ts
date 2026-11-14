// Small registry of NEAR tokens Orbi understands. Contract ids are for NEAR mainnet.
export type Token = {
  symbol: string;
  contract: string | null; // null = native NEAR
  decimals: number;
  swapContract: string; // contract used for routing (native NEAR swaps as wNEAR)
};

export const TOKENS: Record<string, Token> = {
  NEAR: { symbol: "NEAR", contract: null, decimals: 24, swapContract: "wrap.near" },
  WNEAR: { symbol: "wNEAR", contract: "wrap.near", decimals: 24, swapContract: "wrap.near" },
  USDC: {
    symbol: "USDC",
    contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    swapContract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  USDT: { symbol: "USDT", contract: "usdt.tether-token.near", decimals: 6, swapContract: "usdt.tether-token.near" },
};

export function findToken(symbol: string): Token {
  const t = TOKENS[symbol.trim().toUpperCase()];
  if (!t) throw new Error(`Unknown token "${symbol}". Supported: ${Object.values(TOKENS).map((x) => x.symbol).join(", ")}`);
  return t;
}

// "2.5" with 24 decimals -> "2500000000000000000000000" (no floating point)
export function toUnits(amount: string | number, decimals: number): string {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount "${s}"`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Too many decimal places for this token (max ${decimals})`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

export function fromUnits(units: string | bigint, decimals: number, maxFrac = 6): string {
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
