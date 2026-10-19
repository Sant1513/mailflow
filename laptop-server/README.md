# MailFlow laptop server

MailFlow can run entirely on one Windows laptop at no cost. Vercel stays the public front door, so the address the team uses (https://mailflow-six-sooty.vercel.app), Google sign-in, and the unsubscribe and tracking links in sent emails all stay the same.

```
team / Gmail / emails ──► Vercel (middleware.ts: forwards everything)
                              │  Tailscale Funnel (free, fixed https address)
                              ▼
                     laptop: start.mjs ──► app on 127.0.0.1:3100
                                       └─► Postgres on 127.0.0.1:5433 (never exposed)
```

## Where things live

| What | Where |
| --- | --- |
| The app being served | `C:\Users\abhis\mailflow-live`, a git worktree of this repo. Development in `code\mailflow` never disturbs it. |
| Database, settings, logs, backups | `C:\Users\abhis\mailflow-data`, overridden with `MAILFLOW_DATA`. |
| App secrets | `mailflow-data\app.env`. Private: never commit or share it. |
| Database password | `mailflow-data\db.json` |
| Logs | `mailflow-data\logs\server.log` (supervisor and jobs), `app.log` (the app) |
| Backups | `mailflow-data\backups\YYYY-MM-DD\*.csv.gz`. Taken nightly at 03:00 IST; the last 7 are kept. |

## What keeps it running

- **`install.mjs`** adds `MailFlow server.vbs` to the Windows Startup folder. The server then starts, with no window, whenever you sign in, and restarts a minute after it ever stops.
- **`start.mjs`** does the following:
  - starts Postgres;
  - applies new migrations;
  - builds the app if needed, then runs it, restarting it if it crashes;
  - runs every scheduled job (sending every minute, Gmail, follow-ups and Sheets sync every 15 minutes, and the daily jobs).
- **After the laptop has been off**, overdue work runs as soon as it is back:
  - Queued emails carry on sending.
  - Emails that were half-sent are checked against Gmail's Sent folder, so nothing goes out twice.
  - Daily jobs missed by less than 12 hours still run.
- **Tailscale** runs as a Windows service, and its Funnel setting survives restarts.
- **Keep Windows awake:** set Settings → System → Power → "When plugged in, sleep after: **Never**".

## Everyday commands

Run these from `C:\Users\abhis\mailflow-live\laptop-server`:

```bash
node start.mjs                 # start by hand (exits at once if already running)
node install.mjs               # start automatically at sign-in
node install.mjs --remove      # stop starting automatically
```

**To ship a code change to the laptop:** commit it on `master`, then run the following in `mailflow-live`:

```bash
git checkout --detach master && npm ci && npx next build
```

Then restart the server: end the `node.exe` that is running `start.mjs` in Task Manager. The Startup script brings it back within a minute.

## If something goes wrong

- **Postgres exits with code `3221225781`:** the Microsoft Visual C++ runtime is missing. `start.mjs` copies it from `mailflow-data\runtime`. Installing "Microsoft Visual C++ Redistributable (x64)" from Microsoft also fixes it for good.
- **The site shows "MailFlow is offline":**
  1. Check the laptop is on and online.
  2. Run `tailscale funnel status`.
  3. Read `logs\server.log`.
