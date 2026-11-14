// Turns a stream of text fragments into whole sentences, so a sentence can be spoken
// while the model is still writing the next one. Decimals like "11.69" are never split.
export function makeSplitter(emit: (sentence: string) => void, minLen = 25) {
  let buf = "";
  const boundary = new RegExp(`^([\\s\\S]{${minLen},}?[.!?]["')\\]]*)(\\s+)`);
  return {
    push(delta: string) {
      buf += delta;
      for (;;) {
        const m = boundary.exec(buf);
        if (!m) break; // wait for more text
        emit(m[1].trim());
        buf = buf.slice(m[0].length);
      }
    },
    flush() {
      const rest = buf.trim();
      buf = "";
      if (rest) emit(rest);
    },
  };
}
