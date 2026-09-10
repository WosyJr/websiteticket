# Keizaal Online website

A real, working website (not a mockup): players sign in and open tickets that actually get
saved; staff sign in, see them in a real queue, claim/reply/close, and everything persists.
Built with Node.js + Express + SQLite (no separate database server to install) + server-rendered
pages, so the whole thing runs as one process with `npm run dev`.

## What's real right now
- Discord OAuth2 login (staff and players use the same "Continue with Discord" flow)
- A **dev login** bypass so you can test everything before Discord is configured (see below)
- Real ticket creation (General, Player Report, Item Restoration, Staff Report, Bug Report,
  and the three Application types), saved to a real database
- Real staff ticket queue: Overview / Tickets / Applications tabs, filters, search, mass
  actions, claim/close-with-reason
- Real two-way conversation on a ticket, updating live for both sides without a refresh
  (staff-only internal notes that players never see)
- Real "Add Player" -- add another logged-in user to a ticket as a participant, by Discord ID
  or exact site username
- Real Item Restoration Accept/Deny decisions, with a reason sent to the player
- Real Knowledge Base -- General + per-realm tabs, clickable articles with comment threads
- Real Players directory -- every account that's ever signed in is searchable, with their
  ticket history and moderation history
- **Real Moderation Actions** -- Warn / Timeout / Kick / Ban / Role genuinely call the Discord
  API against the target player's account (see "Bot permissions for moderation" below for what
  the bot needs in your server for these to actually take effect). Available to every staff
  member, from a ticket's side panel or a player's own profile page. Actions can be **revoked**
  from that same log (reverses the Discord side where possible -- clears a timeout, unbans, or
  removes the granted role).
- **Moderation against players who haven't linked Discord yet** -- type a raw Discord ID into
  "Take action by Discord ID" on an unresolved Player Report, or into the Players directory
  search, and it creates a lightweight placeholder account you can act on immediately. The
  moment that person actually signs into the site, their real account takes over.
- **Add Player autocomplete** -- start typing a name in "Add Player" and matching accounts pop
  up live instead of needing an exact paste.
- **@mentioning staff in a reply** -- type `@` in the reply box to search and tag another staff
  member; they get a Discord DM saying they're needed on the ticket.
- **Your profile menu** (bottom-left) -- click it to set your status (Available / Busy / Away),
  jump to My Tickets, and see how many tickets you've personally closed.
- **Management tab** (Senior Gamemaster and above only) -- the full staff roster with each
  member's status, tickets open/closed, and moderation actions taken, plus a site-wide recent
  moderation activity feed. Settings is also restricted to this rank now.

## What's NOT built yet (on purpose)
Everything in the original plan is now built. What's left is verifying it on your own machine
with a real Discord server (this sandbox's network can't reach discord.com to test that part
itself -- see "Still needs your own action" in the project notes) and, longer-term, swapping
SQLite for a hosted database before this sees real public traffic (see "Deploying it for real"
below).

## Running it locally (do this first, before anything else)
1. Install [Node.js](https://nodejs.org) 18+ if you don't have it.
2. In this folder: `npm install`
3. Copy `.env.example` to `.env` (no need to change anything yet -- `DEV_LOGIN=true` is on by
   default, so you can test everything without Discord).
4. `npm run dev`
5. Open http://localhost:3000 -- click "Sign in with Discord" and it'll offer a dev-login link
   instead, since Discord isn't configured yet. Try opening a ticket as a player, then in another
   browser (or an incognito window) go to http://localhost:3000/auth/dev-login and log in as
   staff to see it in the queue.

The database is a single file at `data/keizaal.sqlite` -- delete it any time to start fresh
(it's recreated automatically).

## Turning on real Discord login
1. Go to https://discord.com/developers/applications -> New Application.
2. **OAuth2** tab: copy the *Client ID* and *Client Secret* into `.env` as `DISCORD_CLIENT_ID`
   / `DISCORD_CLIENT_SECRET`. Under Redirects, add exactly:
   `http://localhost:3000/auth/discord/callback` (and your real domain's version once deployed).
3. **Bot** tab: click "Add Bot", then "Reset Token" and copy it into `.env` as
   `DISCORD_BOT_TOKEN`. This bot looks up a logged-in user's roles (so the site knows if
   they're staff), sends DMs, posts the activity log, and carries out Moderation Actions.
4. Invite the bot to your Keizaal Online server: **OAuth2 -> URL Generator**, check scope
   `bot`, then under **Bot Permissions** check: Kick Members, Ban Members, Moderate Members,
   Manage Roles, Send Messages -- open the generated URL and add it to your server. See "Bot
   permissions for moderation" below for one more step (role position) these need.
5. In your Discord server, right-click your server name -> Copy Server ID (enable Developer
   Mode in Discord settings first if you don't see this) -> paste into `.env` as
   `DISCORD_GUILD_ID`.
6. Figure out the role IDs for each staff rank (right-click a role in Server Settings -> Roles
   -> Copy Role ID) and fill in `STAFF_ROLE_MAP` in `.env`, e.g.:
   `STAFF_ROLE_MAP={"123456789012345678":"Gamemaster","234567890123456789":"Lead Gamemaster"}`
   The rank name has to exactly match `"Senior Gamemaster"` for someone to get access to the
   Management tab and Settings (see `MANAGEMENT_RANKS` in `src/db.js` if you want to change
   which rank(s) count).
7. Set `DEV_LOGIN=false` once real login works, so nobody can use the bypass.
8. Restart `npm run dev`.

## Bot permissions for moderation
Warn works with no extra setup (Discord has no native "warning" feature, so it's just saved on
the site and optionally DMs the player). Timeout / Kick / Ban / Role genuinely contact Discord,
so two things need to be true in your server:
1. The bot has the Kick Members / Ban Members / Moderate Members / Manage Roles permissions
   (step 4 above).
2. **In Server Settings -> Roles, drag the bot's own role ABOVE** any role it needs to grant
   (the "Role" action) and above the roles of anyone staff might need to timeout/kick/ban.
   Discord silently refuses the action otherwise (you'll see the exact error Discord returned
   in the moderation panel, e.g. "Missing Permissions").
3. If you want the "Role" action to offer specific roles (like a Muted role) instead of a raw
   role ID box, add them under Staff Portal -> Settings -> Assignable roles.

## Deploying it for real (so it has a real URL people can use)
This needs a host that can run a long-lived Node process (not a static host like Netlify/GitHub
Pages -- those won't work for this). Render and Railway both have simple free/cheap tiers that
work well for a small Express app like this:
1. Push this folder to a GitHub repo.
2. On Render or Railway: "New Web Service" -> connect the repo -> build command `npm install`,
   start command `npm start`.
3. Add all the `.env` values as environment variables in the host's dashboard (never commit
   `.env` itself -- it's already in `.gitignore`).
4. Update `DISCORD_REDIRECT_URI` (both in `.env` on the host, and in the Discord app's OAuth2
   redirect list) to your real deployed URL, e.g. `https://your-app.onrender.com/auth/discord/callback`.
5. If you want it at your own domain (e.g. `support.keizaal.com`), point a CNAME at the host
   from wherever your domain's DNS is managed, then add the custom domain in the host's dashboard.

Note: SQLite (a single file) works for testing and light traffic, but most of these hosts wipe
the filesystem on redeploy. Once this is getting real traffic, swap `better-sqlite3` for a
hosted Postgres database (Render/Railway both offer one) -- happy to help with that migration
when you're ready; the SQL is simple enough that it's a small change.

## Project layout
```
src/
  server.js        entry point
  db.js            database schema + seed
  auth.js          Discord OAuth + dev login + role lookup
  discordBot.js    DMs, activity log, and moderation actions (Discord REST API)
  routes/
    auth.js        /auth/* -- login, callback, logout, dev login
    tickets.js      /api/tickets/* -- create, list, reply (with @mention DMs), claim, close,
                     decision, participants
    kb.js           /api/kb/* -- knowledge base articles + comments
    players.js      /api/players/* -- moderation actions, revoke, self status, player search
    pages.js        all the page (HTML) routes, including Players and Management
  lib/
    richtext.js      [label](url) link rendering for KB articles/comments
    relativeTime.js  "142 days ago" style formatting
  views/           EJS templates (server-rendered pages)
  public/
    styles.css      one shared stylesheet, matches the original design mockups
```

## Next steps, in the order we agreed on
1. **You're here:** everything in the original plan is built, testable locally with dev login.
2. Turn on real Discord login and bot permissions (steps above) and confirm staff roles map
   correctly.
3. Test Moderation Actions against a real (non-staff, consenting test) account in your server
   to confirm Timeout/Kick/Ban/Role actually take effect and the DM/log-channel messages land.
4. Deploy it somewhere real so testers can use it from a real URL.
5. Before real public traffic: swap SQLite for a hosted Postgres database (see "Deploying it
   for real" above) -- happy to help with that migration when you're ready.
