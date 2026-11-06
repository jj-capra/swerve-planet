# Swerve Planet

Pick your planet: weave the folded freeways of **Planet Asphalt**, break ankles down a court ten courts long on
**Planet Hardwood**, or truck your way through 300 yards of defense on **Planet Gridiron**. Every planet has a
leaderboard for **today**, **this week** and **all time**.

```
public/index.html              the whole game (one file)
netlify/functions/scores.mjs   the leaderboard API at /api/scores
netlify.toml                   publish folder, functions folder
package.json                   @netlify/blobs (score storage)
```

## Deploy

The leaderboard runs as a Netlify Function, and functions only deploy from **Git** or the **Netlify CLI**.
Dragging the folder onto Netlify Drop would publish the game, but the boards would say they can't connect.

**From GitHub (recommended):** push this folder to a repo, then in Netlify choose *Add new project → Import an
existing project*, pick the repo and deploy. The settings come from `netlify.toml`, so leave the build fields as they are.

**From the CLI:**

```
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```

There's nothing to set up for storage: Netlify Blobs is built in, and the function finds its store automatically.

## How the boards work

- One board per planet per period, stored as a small JSON list in the Blobs store `swerve-scores`
  (`s2/day/hoops/2026-11-04`, `s2/week/hoops/2026-11-02`, `s2/all/hoops`, …). Each keeps the top 100 and shows the top 50.
- `s2` is the season. When scoring changes, bump `SEASON` in `netlify/functions/scores.mjs` and every board starts
  fresh; older seasons stay in the store.
- **Today** rolls over at midnight and **this week** on Monday at midnight, Pacific time. To use another time zone,
  set the environment variable `LEADERBOARD_TZ` (for example `America/New_York`) in the Netlify project settings.
- One row per player: your best score stands, and a worse run doesn't replace it. Players are told apart by a random
  ID kept in their browser, so the same person on a new device or browser is a new player.
- Writes are conditional on the board's ETag and retried, so two players finishing at once can't erase each other.
- Names are up to 12 characters (letters, numbers, `space . _ ! -`), uppercased, with a basic word filter.
- A per-visitor rate limit (40 requests a minute) is set in the function's `config`.

**About cheating:** any browser game's scores can be faked by someone determined. The API rejects scores over 5,000,000 or
faster than 2,000 points per second of play, which stops casual tampering. To wipe a board, delete its entry in
*Netlify → your project → Blobs → swerve-scores*.

## API

```
GET  /api/scores?mode=car|hoops|football&period=day|week|all
     -> { mode, period, key, tz, resetsIn, entries: [{ n: name, s: score, h: player tag }] }

POST /api/scores   { mode, score, name, pid, dur }
     -> { ok, name, h, ranks: { day, week, all } }   (a rank is null when the score missed the top 100)
```
