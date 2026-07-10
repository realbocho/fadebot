# FadeBot — Polymarket Smart Money X-Ray (Telegram Mini App)

See where tracked whales lean on any Polymarket market before you bet.
Copy them — or fade them. Next.js + Supabase + Vercel + Telegram WebApp.

## Features

- **Market X-ray** — paste any Polymarket link → divergence gauge (crowd price
  vs whale lean), tracked whale positions with entry→now transparency, fade signals
- **Trending** — top 24h-volume markets, one tap to x-ray
- **Whale league** — leaderboard-seeded wallets, verified win rate / streaks,
  Smart Money vs Fade Watch tiers, follow/unfollow
- **Alerts** — cron polls followed whales; new BUY trades are pushed to followers
  via the bot with streak/win-rate hooks
- **Portfolio** — link a wallet address (read-only, non-custodial) to see open
  positions and P&L
- **Compliance** — country geoblock middleware (default: KR), English-only UI,
  persistent "not financial advice" disclaimer
- **Deep links** — `t.me/<bot>/<app>?startapp=<market-slug>` opens straight into
  an x-ray (use in X replies / group shares)

## Deploy (GitHub → Vercel)

1. **Supabase**: create a project → SQL Editor → run `supabase/schema.sql`.
   Copy the project URL and the `service_role` key (Settings → API).
2. **BotFather**: `/newbot` → get `BOT_TOKEN`. Then `/newapp` to attach a
   Mini App to the bot (you'll add the URL after step 4).
3. **GitHub**: push this folder to a new repo.
4. **Vercel**: import the repo → set env vars from `.env.example`
   (`BOT_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `CRON_SECRET`, optional `BLOCKED_COUNTRIES`) → deploy.
5. **BotFather again**: set the Mini App URL to your Vercel domain
   (`https://<project>.vercel.app`). Optionally set the menu button to open it.

### First run

Seed the whale league once (crons will keep it fresh):

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/refresh
curl -H "Authorization: Bearer $CRON_SECRET" "https://<domain>/api/cron/refresh?mode=losers"
```

The second call is the **loser harvest**: it scans big trending markets for
large wallets sitting on deep negative PnL — the fade-tier seed the winners-only
leaderboard can never surface. A wallet is fade-tier if it's on a losing streak
(FADE_STREAK_THRESHOLD) **or** its settled win rate is ≤ MAX_FADE_WIN_RATE.
Schedule it daily too: on Vercel Pro add a second cron; on Hobby (2-cron/day
limit, daily granularity) point cron-job.org at the `?mode=losers` URL with the
same Authorization header.

### Crons

`vercel.json` schedules `/api/cron/refresh` daily and `/api/cron/watch` every
5 minutes. **Vercel Hobby limits cron frequency (daily granularity)** — for
5-minute alert polling on Hobby, point an external pinger (e.g. cron-job.org)
at `/api/cron/watch` with the `Authorization: Bearer <CRON_SECRET>` header,
or upgrade to Pro. Vercel automatically sends that header for scheduled crons
when `CRON_SECRET` is set.

If the daily refresh times out (40 wallets ≈ 30–50s), batch it:
`/api/cron/refresh?offset=0&limit=20`, then `?offset=20&limit=20`.

## Architecture

```
app/page.js            client shell (tabs, Telegram init, auth header)
app/components/*       Markets / Whales / Portfolio / Alerts
app/api/xray           market resolve → positions → smart-money summary
app/api/trending       24h volume leaders (cached 120s)
app/api/whales|follow|user|portfolio
app/api/cron/refresh   leaderboard → wallet stats → whales table
app/api/cron/watch     followed whales' activity → alerts via bot
lib/polymarket.js      Polymarket Data/Gamma API (field names verified live)
lib/telegram.js        initData HMAC verification + sendMessage
middleware.js          country geoblock (451 for API, /restricted for pages)
supabase/schema.sql    whales, tg_users, follows, seen_events (RLS locked)
```

Auth: the client sends Telegram `initData` in `x-tg-init-data`; the server
verifies the HMAC against `BOT_TOKEN` (24h freshness) — no passwords, no wallets.

## Phase 3 — Native trading (builder fees) — NOW LIVE IN CODE

Copy/Fade opens an in-app trade sheet: on-device wallet (PIN-encrypted key in
Telegram CloudStorage, never sent to any server) → fund with USDC + a little
POL on Polygon → one-time approvals → fill-or-kill market buy via CLOB V2.
**Every order carries your builder code in the onchain `builder` field** —
that is what attributes volume and accrues your fees.

### Enable fees (one-time)

1. Go to `polymarket.com/settings?tab=builder`, create your builder profile,
   copy the bytes32 **builder code**.
2. Set your **fee rate** in the same profile (rates are public; changes are
   gated: one per 7 days, effective after 3 days).
3. Add `NEXT_PUBLIC_BUILDER_CODE=<bytes32>` in Vercel env → redeploy.
4. Optional but recommended: set `NEXT_PUBLIC_POLYGON_RPC` to a private RPC
   (Alchemy/Infura free tier) — the public RPC rate-limits under load.

### $1 smoke test before announcing (required)

Verified offline: build passes, PIN crypto roundtrip, builder code serializes
into signed V2 orders. **Not verifiable offline — test live with ~$2:**

- [ ] Fund test wallet with $2 USDC + 0.2 POL → approvals succeed
- [ ] `getBalanceAllowance` shows a non-zero tradable balance.
      ⚠️ V2 collateral is `getContractConfig(137).collateral` — if your USDC
      deposit shows $0 tradable, deposit via Polymarket's flow instead and
      read `docs.polymarket.com` Bridge/deposit docs (POST /deposit also
      accepts an X-Builder-Code header for attribution).
- [ ] Place a $1 FOK buy → check the tx: `builder` field = your code
- [ ] Your builder dashboard shows the attributed trade (can lag ~1 day)

### Legal gate (still applies)

Trading is gated on the operator side, not in code: offshore entity, ToS,
counsel sign-off, and `BLOCKED_COUNTRIES` kept current are prerequisites for
turning this on in production. Polymarket can disable builder codes for terms
violations (self-referred volume, abusive fees).

## Compliance notes

- English-only product and marketing; do not target or serve restricted regions.
- The disclaimer in the app footer must stay.
- This tool provides public on-chain data for information/entertainment. It is
  not investment advice, and whale-copying does not guarantee profit — slippage
  between whale entry and current price is always displayed.
