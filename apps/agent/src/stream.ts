import { AiServiceError, kindFromStatus, toAiError } from "./aiErrors.ts";

// How long to wait for the service to start answering, and then between pieces of the answer (tests shorten these).
export const streamTuning = { firstByteMs: 20_000, idleMs: 30_000 };

// Streaming chat completion (server-sent events) with tool-call assembly, OpenAI-compatible format.
export type StreamResult = {
  content: string;
  tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  finish_reason: string | null;
};

export async function streamChat(url: string, headers: Record<string, string>, body: object, onText: (delta: string) => void, firstByteMs = streamTuning.firstByteMs): Promise<StreamResult> {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), firstByteMs);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }), signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw toAiError(e); // no connection, or no answer in time
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new AiServiceError(kindFromStatus(res.status), `NEAR AI Cloud error ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  if (!res.body) throw new Error("No response body");
  const out: StreamResult = { content: "", tool_calls: [], finish_reason: null };
  const dec = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    const choice = j.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) out.finish_reason = choice.finish_reason;
    const d = choice.delta ?? {};
    if (typeof d.content === "string" && d.content) {
      out.content += d.content;
      onText(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const cur = (out.tool_calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
  };
  try {
    for await (const chunk of res.body as any) {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), streamTuning.idleMs); // the answer stalled if nothing arrives for a while
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    }
  } catch (e) {
    throw toAiError(e); // the connection dropped or stalled in the middle of an answer
  } finally {
    clearTimeout(timer);
  }
  if (buf.trim()) handle(buf.trim());
  out.tool_calls = out.tool_calls.filter(Boolean);
  // A tool with no parameters streams an empty arguments string. Sent back as history, the provider rejects it
  // ("tool call arguments must contain valid JSON"), so always store valid JSON.
  for (const tc of out.tool_calls) {
    const a = tc.function.arguments.trim();
    if (!a) {
      tc.function.arguments = "{}";
      continue;
    }
    try {
      JSON.parse(a);
    } catch {
      tc.function.arguments = "{}";
    }
  }
  return out;
}
