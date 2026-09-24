# Putting Math Blitz online (Render + Upstash, both free)

Render runs the game. Upstash stores accounts and scores. You need both because Render's free tier erases its files whenever the server restarts or goes to sleep, which would wipe everyone's accounts.

Plan for about 20 minutes.

## 1. Create the database on Upstash

1. Go to upstash.com and sign up (a Google account works).
2. Create a new **Redis** database. Any name works, like `math-blitz`. Pick the region closest to your Render region (Singapore is closest to the Philippines). The free plan is enough.
3. Open the database and find the **REST API** section. Copy two values:
   - `UPSTASH_REDIS_REST_URL` (starts with `https://`)
   - `UPSTASH_REDIS_REST_TOKEN` (a long string)

Keep the token private. Anyone who has it can edit the scores.

## 2. Put the code on GitHub

1. Create a new repository, for example `math-blitz`.
2. Upload the **contents** of the `math-blitz` folder, keeping the `public` folder as a folder.

Check this carefully, since it caused the "website not found" error with Math Duel: on GitHub, the top level of the repository must show `server.js`, `storage.js`, `package.json` and a `public` folder. If you only see one folder called `math-blitz`, or if `index.html` sits next to `server.js` instead of inside `public`, the structure is wrong.

## 3. Create the web service on Render

1. On render.com, click **New** → **Web Service** and connect the GitHub repository.
2. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install` (there is nothing to install, but Render expects a command)
   - **Start command:** `node server.js`
   - **Instance type:** Free
3. Under **Environment variables**, add:
   - `UPSTASH_REDIS_REST_URL` = the URL from step 1
   - `UPSTASH_REDIS_REST_TOKEN` = the token from step 1
   - `ADMIN_KEY` = a long password for club officers (optional, turns on `/admin.html`)
4. Click **Create Web Service** and wait for the deploy to finish.

## 4. Check it worked

Open the Logs tab on Render. You should see:

```
Storage: Upstash Redis
```

If it says `local file` instead, along with a warning, the two Upstash variables are missing or misspelled. Fix them and Render redeploys automatically.

Then open your `.onrender.com` link, create a test account, and play a game. It should appear on the leaderboard. Restart the service from Render's menu and check that the account and score are still there.

## Things to know

- **The first visit can be slow.** Free Render services fall asleep after about 15 minutes without visitors, and the first visit wakes them in roughly a minute. Open the site yourself a few minutes before an event.
- **Upstash's free limits** are far more than a club needs. A game plus a leaderboard refresh uses a couple dozen database commands.
- **Updating the game:** push changes to GitHub and Render redeploys. Accounts and scores stay in Upstash and survive every update.
- **Starting a fresh season:** the monthly board resets automatically. To wipe everything, delete and recreate the Upstash database, then update the two variables on Render.
