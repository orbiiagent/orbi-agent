# Orbi demo script (about 2 minutes 30 seconds)

One complete moment: a spoken question, a real quote, a spoken swap request, a tap on Approve, a real mainnet result. Then the bridge in, shown briefly. No architecture slides.

## Before recording (checklist)

1. **NEAR AI Cloud is up.** Ask one question that needs the model (for example "What's a good way to think about stablecoin yields?"). If it fails, wait and retry; do not record with the service down.
2. **Wallet is funded and `ORBI_EXECUTION=live`** if you want a real swap on camera. Current balances were about 0.85 NEAR and 1.78 USDC. Swap a small amount (0.3 NEAR or less). The per-action cap is $10.
3. **Warm the page:** open http://127.0.0.1:3000, wait for "Warming up the rate data" to disappear, ask the price question once so the answers and voice are cached (this spends a few ElevenLabs credits once).
4. **Use headphones** so Orbi does not hear itself. Quiet room. Settings: Background noise = Quiet room or Normal.
5. **Screen record at 1080p**, browser full screen, notifications off, no secrets visible (do not open `.env`, the key, or Settings fields with your address).
6. **Do not send USDC from Base during the video.** A real bridge takes minutes, and a wrong amount is not bridged. Show the deposit card and QR only (scene 5).
7. Have the swap transaction link ready to open in nearblocks afterwards.

## Scenes

### 1. Hook (0:00 to 0:15)
**Screen:** Orbi's orb, centered.
**Voice-over (you, calm):** "Managing crypto means a lot of tabs and a lot of clicking. Orbi is a voice agent on NEAR: you talk, it does the research, and nothing moves until you tap approve."

### 2. Research by voice (0:15 to 0:45)
**You say:** "Hey Orbi."
**Orbi:** short greeting.
**You say:** "What's the USDC lending rate?"
**See:** one-sentence spoken answer and the "what Orbi just checked" strip.
**You say:** "What about USDT?" (follow-up, instant answer)
**Point out (voice-over):** "Live rates from Rhea. The numbers come from code, not from the AI."

### 3. Best route (0:45 to 1:10)
**You say:** "Quote 0.3 NEAR to USDC."
**See:** Orbi names the better route between NEAR Intents and Rhea and the estimated USDC.
**Voice-over:** "Orbi compares NEAR Intents and Rhea and picks the better one after fees."

### 4. The swap, the real moment (1:10 to 1:50)
**You say:** "Swap 0.3 NEAR to USDC."
**See:** the approval card (amount, estimated output, fee, expiry bar).
**You say, to show the rule:** "Yes, do it." **See:** nothing happens.
**Voice-over:** "Saying yes out loud does nothing. Only a tap approves."
**Tap Approve.** **See:** status running, then done.
**Show:** the transaction on nearblocks (cut or speed up the wait; the real swap took about 50 seconds).
**Voice-over:** "That was a real swap on NEAR mainnet."

### 5. Bring money in from Base (1:50 to 2:15)
**You say:** "Bring in 10 USDC from Base."
**See:** deposit card with the Base address and QR code, "send exactly" warning, refund address.
**Voice-over:** "Exchanges like OKX and Binance don't withdraw to NEAR. Orbi sets up a NEAR Intents deposit: you send USDC from Base and it arrives as NEAR. Orbi signs nothing on Base and holds no Base key. I tested this on mainnet: 5 USDC became about 1.4 NEAR."
**Close the card** (do not send anything).

### 6. Close (2:15 to 2:30)
**Screen:** orb again.
**Voice-over:** "This is a prototype. Today Orbi acts on a small demo wallet. Next, you connect your own wallet, and Orbi works in the background: always listening for 'Hey Orbi', tracking the market, and helping you manage your crypto on chain. The code is open source."
**End card:** repo link.

## If something goes wrong on camera

- **AI service down:** Orbi says so itself and lists what still works. Stick to balances, prices, rates and quotes (scenes 2 and 3 use the fast path and do not need the model for most answers).
- **Voice misheard:** type the sentence in the box instead; it does the same thing.
- **Swap fails or is cancelled by the quote-drift check:** that is the safety design working. Say so, retry once, or switch to `rehearsal` and note it on screen.
- **Rehearsal option:** if you do not want a real swap, set `ORBI_EXECUTION=rehearsal`. The card then says rehearsal and nothing is signed. Say that clearly in the video.

## Facts you can say (all verified)

- Real mainnet swap: 0.5 NEAR to USDC via Rhea, received 1.7856 USDC, tx `5B3mKrNoWvujfJuTyg6hJ32udJMCzj8zFrA3VDa5Xonv`.
- Bridge: 5 USDC from Base arrived as about 1.39 NEAR in Orbi's wallet through NEAR Intents.
- Model and speech-to-text run on NEAR AI Cloud. Reply voice is ElevenLabs (third party).

## Do not claim

- Do not say funds are safe from every attack; say "limits and approval are enforced in code".
- Do not say a phone app, extension, SMS or market alerts exist. They are the roadmap.
- Do not say the voice is fully private: default listening uses the browser's speech service.
