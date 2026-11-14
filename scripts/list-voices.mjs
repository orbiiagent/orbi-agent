// Lists the voices available to your ElevenLabs account so you can pick ELEVENLABS_VOICE_ID.
// Run: node --env-file=.env scripts/list-voices.mjs   (read-only, costs no credits)
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("ELEVENLABS_API_KEY is missing from .env");
  process.exit(1);
}
const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
if (!res.ok) {
  console.error(`ElevenLabs returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const { voices } = await res.json();
console.log(`${voices.length} voices available:\n`);
for (const v of voices) {
  const l = v.labels ?? {};
  const tags = [l.gender, l.age, l.accent, l.descriptive, l.use_case].filter(Boolean).join(", ");
  console.log(`${v.name.padEnd(22)} ${v.voice_id}   ${tags}`);
}
console.log("\nPut your pick in .env as ELEVENLABS_VOICE_ID=<id>. Preview voices at elevenlabs.io before choosing.");
