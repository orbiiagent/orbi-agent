// Speech recognisers mishear the words this product depends on. Fix the common ones before anything else sees the text.
// Measured with Whisper: "NEAR" -> "NIR", "Rhea" -> "RIA", "Orbi" -> "Orby".
export function fixSpeech(text: string): string {
  return text
    .replace(/\b(?:nir|neer|nier)\b/gi, "NEAR")
    .replace(/\b(?:ria|rya|reya|rhia|riya)\b/gi, "Rhea")
    .replace(/\bu\.?\s?s\.?\s?d\.?\s?c\b/gi, "USDC")
    .replace(/\bu\.?\s?s\.?\s?d\.?\s?t\b/gi, "USDT")
    .replace(/\busd coin\b/gi, "USDC")
    .replace(/\b(?:orby|orbie|orbee|orbit)\b/gi, "Orbi")
    .replace(/\s+/g, " ")
    .trim();
}
