# Prism Arena

First-person sky arena shooter that runs in the browser. Six modes on two maps (Prism Spire and Frostfall):

- **Squad Waves**: co-op. Everyone in the room fights the same drone waves.
- **Boss Raid**: co-op. Take down a giant Titan with three phases. Its orbiting core takes double damage.
- **Free-for-All**: first to 20 kills. Kill streaks call in an air strike (5) and a sentry drone (10).
- **Gun Game**: free-for-all. Every kill swaps your gun (SMG → Rifle → Scatter → Hand Cannon → Rail → Nova → Blade). A Blade kill wins.
- **Capture the Flag**: Red vs Blue. First team to 3 captures wins.
- **Infection**: one player starts infected. Survivors last 3 minutes; anyone killed joins the infected.

Bots fill empty slots, so every mode works solo. The website version also has friends (add by player ID), invites and player profiles; those need the server.

## Run it on your computer

Install [Node.js](https://nodejs.org) (version 18 or newer), then in this folder run:

```
npm install
npm start
```

Open http://localhost:3000. Friends on the same Wi-Fi can join at `http://<your-computer's-IP>:3000`.

## Put it online as a real website (free)

The easiest free host that supports multiplayer is **Render**:

1. Make a free GitHub account and create a new repository. Upload `prism-arena.html`, `server.js`, `package.json` and `.gitignore` (not `node_modules`).
2. Make a free account at https://render.com and click **New → Web Service**. Connect your GitHub repo.
3. Use these settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
4. Click **Create Web Service**. After a minute or two you get a link like `https://prism-arena.onrender.com`. Share it with your friends.

Free Render servers go to sleep when nobody is playing, so the first visit after a while can take about 30 seconds to load.

Other hosts that run Node apps (Railway, Fly.io, Glitch) work the same way: install with `npm install`, start with `npm start`.

### Creator codes

Players can enter a creator code (`AUSTEN`, `BECKET`, `JMONEY` or `HARRYBALLS`) in the Shop. Each purchase sends that creator 10% of the price as bonus coins. The buyer still pays the normal price.

Coins go to the creator's **player ID**, not their callsign, so renaming or copycat names don't matter. To link a code to a player:

1. Have the creator open the game (any mode, even just the menu). Their player ID is in **Settings → Account**, or:
2. While they're online, open `https://<your-site>/players`. It lists everyone online with their callsign and player ID.
3. In Render, open your service → **Environment** → **Add Environment Variable**:
   - Key: `CREATOR_CODES`
   - Value: `AUSTEN:P-xxxxxxxxxx,BECKET:P-yyyyyyyyyy` (use the real IDs)
4. Save. Render restarts the server with the new setting.

Payouts arrive the next time the buyer and the creator are online at the same time (any mode or room). Until then they wait in the buyer's browser.

### Solo-only static version

If you only want a single-player page (bots, no multiplayer), run `npm run build`. Then upload `dist/index.html` to any static host, such as GitHub Pages, Netlify or itch.io.

## Files

- `prism-arena.html`: the whole game.
- `server.js`: serves the game and relays multiplayer over WebSockets.
