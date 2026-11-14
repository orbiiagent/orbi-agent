# Orbi: talk to your NEAR wallet

Orbi is a voice-first agent that helps you manage your crypto on NEAR. You talk to it ("Hey Orbi"), it researches (balances, prices, lending rates, swap quotes), and when you ask for a swap or a payment it puts an **approval card** on screen. Nothing moves until you tap **Approve**. Saying "yes" out loud never approves anything.

Built during the NEAR hackathon window (started 2026-11-04). Works on **NEAR mainnet**; the default mode is `rehearsal`, which runs the full flow and never signs or sends anything. This is a prototype: for the demo it acts on a small test wallet, and the plan is for you to use your own (see below).

## Prototype today, where Orbi is going

**This is a prototype.** To keep the demo small and safe, Orbi owns a small NEAR wallet of its own and you fund it with a few dollars. That is a demo shortcut, **not how Orbi is meant to work**.

The goal: **Orbi is an agent that helps you manage your crypto on chain.** The next versions are planned to:

- **Your own wallet:** let you create a wallet inside Orbi or connect the wallet you already use, so Orbi works with your funds and you stay in control. Orbi would propose, you approve, as it does now.
- **More seamless operation:** an always-on "Hey Orbi" app or extension on desktop and phone, with no website to open and no demo setup.
- **Proactive help:** track the market and your positions and tell you what changed, not only answer when asked.
- **More on-chain actions:** more chains and more things to do (sends across chains through NEAR Intents, lending, and others), with the same approval and limits model.

What a judge should take from the demo today is the interaction model and the safety design: conversational voice, real quotes from NEAR Intents and Rhea, real mainnet execution, and an approval card with limits enforced in code. The wallet setup is the part that will change. Details are under [Roadmap](#roadmap-not-built).

## What it does

| You say | Orbi does |
| --- | --- |
| "What's in my wallet?" | Reads token balances (NEAR, wNEAR, USDC, USDT) from NEAR RPC. |
| "What's the USDC lending rate?" / "Find a stablecoin yield between 2 and 5 percent" | Reads live APYs for NEAR DeFi (Rhea lending, pools, staking) and flags thin pools. |
| "Quote 5 NEAR to USDC" | Compares routes from **NEAR Intents** and **Rhea SmartRouterV2**, picks the best after fees. Quote only. |
| "Swap 0.5 NEAR to USDC" | Shows an approval card with amount, estimated output, fee and expiry. After you tap Approve, Orbi signs and runs the swap on Rhea. |
| "Send 1 NEAR to Treasury" | Same, for a **saved contact** (your own wallets, by name). Orbi never accepts or speaks an address by voice. |
| "Bring in 20 USDC from Base" | Creates a deposit card with a real NEAR Intents deposit address on Base plus a QR code. You send the USDC from your own wallet or exchange; Intents bridges it and delivers NEAR to Orbi's wallet. Orbi holds no Base key. |
| "Did it go through?" / "What was my last transaction?" | Reads Orbi's own activity log and double-checks real transactions on-chain. |
| "Remember that I prefer short answers" / "Forget that" | Keeps up to 30 short notes about you (see Memory). |

## Safety model: the model proposes, code enforces

- The AI model can only **propose**. Every amount, quote and transaction is built by deterministic code, never by the model.
- **Approval card** for every swap, send and deposit: single-use, expires after 120 s, bound to a hash of exactly what was shown. A newer proposal replaces the old one.
- **Limits in code**: $10 per action, $25 per day, first payment to a new contact at most $5, a 0.2 NEAR reserve is always kept, a swap is cancelled if the fresh quote is more than 1% worse than the approved one. Limits are re-checked at approval time.
- **Contacts only**: payments go to saved names. Addresses are never accepted by voice and never read aloud.
- **No loosening by chat**: memory refuses notes about addresses, keys, limits or approval rules; the system prompt treats memory as background data only.
- Cross-site requests and foreign Host headers are refused by the local server. Secrets live only in `.env` / `.secrets` (git-ignored).
- Three execution modes via `ORBI_EXECUTION`: `off` (lookups only), `rehearsal` (default; full flow, nothing signed), `live` (real transactions).

## Verified on mainnet

| What | Result |
| --- | --- |
| Swap 0.5 NEAR to USDC via Rhea, tapped Approve | Done. Quoted about 1.7837 USDC, received 1.7856 USDC. Transaction `5B3mKrNoWvujfJuTyg6hJ32udJMCzj8zFrA3VDa5Xonv` ([nearblocks](https://nearblocks.io/txns/5B3mKrNoWvujfJuTyg6hJ32udJMCzj8zFrA3VDa5Xonv)). |
| Bring in 5 USDC from Base through a NEAR Intents deposit address | Done. About 1.39 NEAR arrived in Orbi's wallet (native NEAR; the account was created by the delivery). |
| Plain NEAR transfer to a contact | Tested on testnet (verified independently over RPC). |

Not verified: real-microphone behaviour in noisy rooms (the noise gate was only tested with synthetic audio).

A lesson from testing: a deposit must be **exactly** the amount on the card. An underpaid deposit is not bridged; per the Intents API it is refunded to the refund address after the quote deadline. Orbi's card says "send exactly".

## Try it hosted (no setup)

**Live demo: [HOSTED URL, added when deployed]**

Open the link, tap the orb or type, and try "What's the USDC lending rate?" or "Swap 0.3 NEAR to USDC". The hosted copy is a shared demo with a **small live test wallet**: real funds, tiny amounts. Each action is capped at $0.50, the whole demo at a small daily total, and each visitor gets a few real actions a day. You can swap, and send only to one saved contact (Treasury, the project owner's own wallet). Nothing of yours is touched: do not send your own funds anywhere. Your notes and settings are private to your browser (a cookie, no account). Base deposits are switched off there; run Orbi locally to try them.

## Try it locally

Requirements: Node >= 22.18 (it runs TypeScript directly), a NEAR AI Cloud API key (cloud.near.ai). A Chromium browser or Safari for voice.

```bash
npm install
cp .env.example .env            # then fill in NEAR_AI_API_KEY
node scripts/gen-agent-key.mjs  # creates the agent wallet keypair, put the values in .env
npm test                        # 111 unit tests, no network or keys needed
npm run web                     # open http://127.0.0.1:3000
```

Do X, see Y (rehearsal mode, no funds needed):

1. Type or say **"What's the USDC lending rate?"** and a one-sentence answer appears and is spoken, with a "what Orbi just checked" strip.
2. Say **"Quote 5 NEAR to USDC"** and Orbi names the better of the NEAR Intents and Rhea routes and the estimated output.
3. Say **"Swap 1 NEAR to USDC"** and an approval card appears. Say "yes, do it": nothing happens. Tap **Approve**: the card shows a rehearsal result, no transaction is made.
4. Say **"Bring in 10 USDC from Base"** (after pasting your own Base address in Settings, Bridge) and a deposit card with an address and QR code appears.
5. Say **"Remember that I follow NEAR and USDC rates"**, then ask "What do you remember about me?" and say "Forget that" to delete it.

Without keys the page still loads, but model-based answers need `NEAR_AI_API_KEY`. Balances, prices, rates and quotes use public endpoints.

To use real money (start with a few dollars): fund the agent account, set `ORBI_EXECUTION=live` in `.env`, restart. NEAR Intents and Rhea exist only on mainnet. Keep `ORBI_MAX_ACTION_USD` and `ORBI_MAX_DAILY_USD` low.

## Architecture

```
Browser  (orb UI, wake word "Hey Orbi" on-device, tap-to-talk, approval cards)
   |  speech: browser recogniser (fast, default) or Whisper on NEAR AI Cloud (private option)
   v
Local server  apps/web/server.ts        HTTP API, rate limits, cross-site protection
   v
Agent         apps/agent/src
   agent.ts      streaming model loop (NEAR AI Cloud, OpenAI-compatible, tool calling)
   fastpath.ts   code-only answers for balances, prices, rates, quotes, small talk
   tools.ts      propose_swap, propose_send, propose_deposit, get_balances, get_prices,
                 get_yields, get_swap_quote, get_last_transaction, get_deposit_status,
                 remember, forget
   policy.ts     caps, reserve, daily limit            (deterministic, unit tested)
   actions.ts    approval cards, single-use hashes, audit log
   executor.ts   the only code that triggers transactions
   chain.ts      the only writer, uses near-api-js (agent key stays server-side)
   quotes.ts     NEAR Intents 1Click + Rhea SmartRouterV2 comparison
   bridge.ts     Base to NEAR deposits through Intents 1Click
   memory.ts     small, safe, deletable notes
```

NEAR pieces used: NEAR AI Cloud (chat model and Whisper, TEE-backed), NEAR Intents 1Click (quotes, cross-chain deposits, status), Rhea SmartRouterV2 (swaps), NEAR RPC and an agent-owned implicit account, near-api-js.

## Honest notes

- **Privacy**: the model and Whisper run on NEAR AI Cloud. The default fast listening uses the **browser's speech recogniser**, which sends audio to the browser vendor; turn it off in Settings to use Whisper instead. The reply voice uses **ElevenLabs** (optional, off without a key), so the text Orbi speaks goes to a third party outside the TEE. With no ElevenLabs key the voice option is off and answers stay as captions unless you tick the browser voice in Settings.
- **Custody**: this is a prototype setup, chosen so the demo is small and safe. The agent owns a small wallet with a key on the server, so use a few dollars only. It is not the intended design: the plan is for you to create or connect your own wallet, with Orbi proposing and you approving.
- **Hosting a shared copy**: on your own computer Orbi has one owner. With `ORBI_MULTIUSER=on`, each browser gets a private random id (a cookie) and its own memory, habits, contacts and refund address, so visitors never see each other's data. A shared copy runs in rehearsal mode (nothing is signed) unless the operator deliberately enables a small live wallet (`ORBI_ALLOW_PUBLIC_LIVE=1`). In that case it shows a banner, caps each action and the day's total (for example $0.50 and $5), caps the number of real actions per day, runs real actions one at a time, lets visitors send only to one saved contact (Treasury, the operator's own wallet), and keeps Base deposits switched off, because the demo wallet is shared. There are no accounts yet: a new browser or device starts clean.
- **Routing fee**: Orbi charges **no fee** in this demo (`ORBI_FEE_PER_MILLE=0`). The code can add an optional app fee to Rhea swaps (`ORBI_FEE_PER_MILLE`, per mille, with a recipient in `ORBI_FEE_RECIPIENT`); when it is on, it is shown on the card. The verified swap above was run with a 0.1% fee switched on; later runs have it off.
- **Wake word**: on-device openWakeWord with a custom "hey orbi" model trained for this project; the engine and onnxruntime-web are vendored. Stock openWakeWord models are CC BY-NC-SA, which is why a self-trained model is used.
- **Tests**: 111 unit tests (policy, approval flow, execution order, bridge, memory, streaming, speech fixes). Microphone capture, audible playback and real-room noise handling need a human to check.

## Roadmap (not built)

Orbi is meant to become an agent that helps you manage your crypto on chain. None of the items below exist yet, and none are claimed above.

1. **Your wallet, not Orbi's.** Create a wallet in Orbi, or connect an existing one. Funds stay yours; Orbi proposes and you approve, with limits and permissions you set.
2. **More seamless operation.** An always-on app or browser extension on desktop and phone with the "Hey Orbi" wake word, so you do not open a website or set anything up.
3. **Proactive updates.** Watch the market, your balances and your positions, and speak up when something you care about changes.
4. **More on-chain actions.** Cross-chain sends through NEAR Intents, lending and other DeFi actions, read-only market data from other venues.
5. **Other ways in.** SMS or text control for when there is no data connection, and MCP or agent-runtime integrations.

## Credits and baseline

- Voice-wallet projects exist on other chains (for example TOMI and Wally on Solana). Orbi's angle on NEAR is best-rate routing, cross-chain deposits through Intents, and the approval-card safety model.
- Libraries: near-api-js 7.2.0 (MIT), openWakeWord and onnxruntime-web (vendored), qrcode-generator 1.4.4 (MIT, vendored). Services: NEAR AI Cloud, NEAR Intents, Rhea, DefiLlama yields, ElevenLabs (optional).
- Everything in this repository was built in the hackathon window with AI assistance (Claude Code).

## License

MIT, see `LICENSE`.
