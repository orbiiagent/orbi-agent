import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, synthesize, voiceEnabled, VoiceError } from "../src/voice.ts";

test("prepare strips markdown and caps length", () => {
  assert.equal(prepare("**Hello** `world`   there"), "Hello world there");
  assert.equal(prepare("x".repeat(900)).length, 500);
});

test("voice is off without an API key and voice id", async () => {
  if (voiceEnabled()) return; // only meaningful when keys are absent
  await assert.rejects(() => synthesize("hi"), (e: unknown) => e instanceof VoiceError && e.status === 501);
});
