# X post draft (you post it, then give me the link)

Rules from the hackathon: say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, attach the demo video. Optional: @NearLegion @NearBuilders.

## Version A (recommended, under 280 characters for the main post)

Managing crypto on chain means tabs, clicks and copy-pasted addresses.

Orbi is a voice agent on NEAR: ask for rates, compare routes, swap by talking. Nothing moves until you tap approve.

Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon

[video]

## Reply 1 (thread, NEAR's role)

How NEAR is used:
- NEAR AI Cloud runs the model and speech-to-text
- NEAR Intents compares routes and brings USDC in from Base (exchanges like OKX and Binance can't withdraw to NEAR)
- Rhea runs the swap on NEAR mainnet
The AI only proposes. Limits and approval are enforced in code.

## Reply 2 (links and ask)

The numbers in the video come from my real mainnet transactions (swap, send, Base deposit), listed in the README.
Try it live: https://orbi-agent-production.up.railway.app/
This is a prototype: Orbi uses a small demo wallet today. Next: your own wallet, always-on "Hey Orbi", and market updates.
Repo: https://github.com/orbiiagent/orbi-agent
What would you want Orbi to do for you first?

## Alternate Version B (shorter)

I built Orbi at NEAR HACKATHON: say "Hey Orbi, swap 0.3 NEAR to USDC", see an approval card, tap approve, done on mainnet. Quotes from NEAR Intents and Rhea, model on NEAR AI Cloud.

@NEARProtocol #NEARHackathon @NearLegion @NearBuilders

[video]

## Notes

- The video shows a swap of 1.78 USDC to 0.54 NEAR, a send of 1.128456 NEAR and a 5 USDC Base deposit arriving as about 1.4 NEAR. Those are real figures from mainnet, shown as a re-creation in the UI; the final "Unwrapping to NEAR" stage comes from code that has not yet run live, so say "based on" and not "recorded live" if anyone asks.
- The repo link is already filled in. Post only after the repo is public.
- Do not include your wallet addresses or any key in the post or the video.
