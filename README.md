# Math Blitz!

A 60-second mental arithmetic game for the VCSMS Mathematics Club. Players make an account, race the clock, and compete on a monthly and an all-time leaderboard. Same comic-book look as Math Duel.

No npm packages are needed. You only need Node.js 18 or newer.

## How a ranked game works

- The clock runs for 60 seconds after a 3-2-1 countdown.
- Players type the answer; it goes through the instant it's right. There is no Enter key and no wrong-answer penalty, only lost time.
- Space (or the Skip button) skips a problem, but freezes the player for 2 seconds.
- Problems get harder as the player gets more right, and harder ones are worth more:

| Level | Unlocks after | Points each | Problems |
|---|---|---|---|
| 1 | start | 1 | two-digit + and − |
| 2 | 8 correct | 2 | three-digit ± two-digit, one-digit × two-digit, easy ÷ |
| 3 | 20 correct | 3 | three-digit ± three-digit, bigger × and ÷ |
| 4 | 35 correct | 4 | two-digit × two-digit, four-digit ±, a × b + c, harder ÷ |

The leaderboard ranks by points. Each player's best score counts. The monthly board resets on the 1st, using Philippine time (change it with the `TIMEZONE` setting).

Practice mode lets players pick operations, a level, and 30 s, 60 s or 2 minutes. Practice scores are not saved.

## No repeated problems

Problems are generated on the spot, not pulled from a fixed list. Every problem gets a fingerprint, and "7 × 48" and "48 × 7" count as the same problem.

- Within a game, a problem never appears twice.
- Across games, the server remembers the last 5,000 problems each player has seen and avoids all of them. At about 30 to 50 problems a game, that's over 100 games before anything could come back.
- Every answer is whole and positive. The generator was tested on 60,000+ problems with every answer checked independently.

## Cheating protection

The server creates each ranked game's problems and keeps its own copy. When the game ends, the server replays every answer and rejects the score if an answer is wrong, if answers came in faster than a person can type (under 0.1 s apart), if someone answered during a skip freeze, or if the game finished faster than real time allows.

This stops the easy tricks, like editing a score in the browser. A determined student who can write code could still script the game, since the browser needs the answers to check them instantly. For a club leaderboard this is a reasonable trade for a game that feels instant.

## Running it on one computer or over Wi-Fi

1. Install Node.js (the LTS version) from nodejs.org.
2. Unzip this folder.
3. Open the folder in File Explorer, click the address bar, type `cmd`, and press Enter. A command window opens in the right folder.
4. Run:
   ```
   node server.js
   ```
5. Open the address it prints. On this computer, that's `http://localhost:3000`. Other devices on the same Wi-Fi use the "Same Wi-Fi" address. If Windows asks about the firewall, allow access on **Private** networks, and make sure the Wi-Fi is set to Private (the Math Duel `WINDOWS-SETUP.md` guide covers this in detail).

Accounts and scores are saved in `data/db.json`. Back up that file to keep them.

## Hosting it online

See `RENDER-DEPLOY.md`. Render's free tier wipes files on every restart, so online hosting uses a free Upstash Redis database for accounts and scores. The guide walks through it.

## Club officer tools

Set an `ADMIN_KEY` (any long password) when starting the server:

```
set ADMIN_KEY=choose-a-long-secret
node server.js
```

(On Render, add it as an environment variable instead.) Then open `/admin.html` to:

- reset a player's password (it also signs them out everywhere),
- remove a player from every leaderboard,
- delete an account so the username is free again.

Without `ADMIN_KEY`, the admin page is switched off.

## Settings

| Setting | What it does | Default |
|---|---|---|
| `PORT` | port to listen on | 3000 |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | store data in Upstash instead of a local file | not set |
| `DATA_DIR` | folder for the local data file | `./data` |
| `ADMIN_KEY` | turns on `/admin.html` | not set |
| `TIMEZONE` | when the monthly board rolls over | `Asia/Manila` |

Game rules (60 s, 2 s skip freeze, level thresholds) are at the top of `server.js` and in `public/generator.js`.

## Files

```
math-blitz/
├── server.js            accounts, game checking, leaderboards, admin
├── storage.js           local file storage or Upstash Redis
├── package.json
├── README.md
├── RENDER-DEPLOY.md
└── public/
    ├── index.html       the game
    ├── generator.js     problem generator (used by the server and the browser)
    └── admin.html       club officer tools
```
