# 3 to 14

The Cloudflare Worker serves the game from `og_static_files/`. Local play supports pass-and-play and solo games. Online play uses room codes, a Durable Object per room, and WebSockets.

In-progress local games are saved in browser storage and restored after a page reload. Hands use a responsive, non-scrolling layout; clicking two cards swaps them, while dragging rearranges them and can leave a few dashed organizing spaces at the end of the hand. These interactions work even when it is not your turn, and cards can also be dragged from a pile into the hand to draw. Games use only enough standard 54-card decks to deal round 14, and shuffle discards back into the draw pile when it runs out. Online room credentials remain tab-scoped; the authoritative room game is held by its Durable Object. Online players receive a turn-start popup and can send preset game quotes in chat. A player who leaves is removed from the active game; when the host closes the room, everyone is returned to the menu after acknowledging the notice.

The host can choose whether 2s are wild when starting a game. Solo leaderboard ranks are separated by this setting rather than applying an arbitrary handicap, so runs with different rules are not compared as if they had the same difficulty. Players may lay down when their entire hand can be partitioned into sets or same-suit runs of at least three cards. Jokers and the current round rank are wild; 2s are wild only when enabled. Aces can be low or high, but runs do not wrap. In multiplayer, cards that can be partitioned into disjoint sets or runs do not score; the game finds the grouping that leaves the lowest-value unmatched cards, and only those unmatched cards add points. Round history shows points gained in that round, while the scoreboard shows the cumulative total. Solo runs auto-discard without a confirmation dialog, show the player's hand immediately, and pause the timer while the scoreboard is open. At the end, the score is `max(0, 100000 - 1000 × total turns - elapsed seconds)`, so higher scores are better.

The room host can remove a player from the lobby or active room after confirming the action. For testing, clicking the "Round" label 13 times opens the round-skip password dialog; choose a later round to skip to, or choose round 15 to finish the game. Every skipped round is recorded with 0 points, and skipped solo runs are ineligible for either leaderboard. The password is read only by the Worker from `ROUND_SKIP_PASSWORD`; it is never bundled into the browser code.

Solo records are saved both in the current browser and in a shared top-10 list for each 2s-wild setting. The menu toggle displays one setting at a time; historical entries without a recorded wild-card setting are not shown. The shared list is for casual play, does not require an account, and does not verify submitted scores against a server-run solo game.

The completed-game scoreboard congratulates the winner or tied winners. Score, rules, and turn popups can be dismissed from outside; the online turn prompt also closes on any click.

## Run locally

```powershell
npm install
npm run dev
```

Open the local URL Wrangler prints. Room state and the global leaderboard use Wrangler's local Durable Object storage during development.

To enable password-protected round skipping locally, copy `.dev.vars.example` to `.dev.vars`, replace the placeholder with your own private password, and restart Wrangler. `.dev.vars` is git-ignored. For the deployed Worker, configure the same secret with `npx wrangler secret put ROUND_SKIP_PASSWORD`. Do not commit the secret.

Run the game-rule tests with:

```powershell
npm test
```

## Deploy

```powershell
npm run deploy
```
