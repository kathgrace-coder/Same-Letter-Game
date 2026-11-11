# Same Letter, Different Words — Live Race Edition

Your clues and answers from the PowerPoint (letters A, H, J, L, P, R, V only — 35 clues), turned into a live game. The host shows the clue on a shared screen;
everyone types the answer on their own phone/laptop; fastest correct answer earns the most points.

## Run it (needs Node.js 18+, nothing else to install)

    node server.js

Then open  http://localhost:3000/host.html  to host. Players open the address shown + enter the 4-letter code.

## Getting your team connected

* **Same office / same Wi-Fi:** use the "Same Wi-Fi" address printed when the server starts.
* **Remote team (most likely):** the server needs a public address. Easiest options:
  1. **Render / Railway / Fly.io** (free tiers): upload this folder (or push to GitHub), choose "Web Service",
     start command `node server.js`. Share the URL they give you. (A Dockerfile is included too.)
  2. **Temporary tunnel from your own computer:** run the game, then in another window run
     `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`) and share the https link.

## Hosting a game
1. Host page → pick letters, seconds per clue, scoring → **Create lobby**.
2. Share the invite link (button copies it). Players appear live.
3. **Start game**. Share your screen showing the host page (the answer is never shown until time is up).
4. Each clue ends when time runs out or everyone has answered. Answer is revealed, then it auto-advances (or click Next).
5. End screen: podium + full leaderboard. Download **Scores CSV** or **Clue-by-clue CSV**. Results are also saved to `results/`.

## Scoring
* **Speed race (default):** 100 + up to 100 speed bonus + 30/20/10 for 1st/2nd/3rd correct. Ties broken by total answer time.
* **Classic:** 1 point per correct answer (X, Y, Z = 2, as in your deck).

## Notes
* Answers ignore capitals, spaces, hyphens and punctuation ("self awareness" = "Self-awareness").
* Players can keep guessing until they get it right. Refreshing the page rejoins them with their score.
* Edit clues/answers in `data/questions.json` (optional `alt` list for extra accepted spellings).
* Game state lives in server memory: restarting the server ends running games.
