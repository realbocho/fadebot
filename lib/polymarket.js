// Polymarket public API helpers (endpoints verified against live responses).

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const cfg = {
  seedCount: Number(process.env.SEED_WALLET_COUNT || 40),
  minClosed: Number(process.env.MIN_CLOSED_POSITIONS || 10),
  minWinRate: Number(process.env.MIN_WIN_RATE || 0.55),
  fadeStreak: Number(process.env.FADE_STREAK_THRESHOLD || 5),
};

export function pick(obj, ...keys) {
  for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null) return obj[k];
  return undefined;
}

function firstList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const v of Object.values(payload)) if (Array.isArray(v)) return v;
  }
  return [];
}

async function getJson(url, params) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(url + qs, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`Polymarket API ${res.status}: ${url}`);
  return res.json();
}

// ── Leaderboard → seed wallets ────────────────────────────────
export async function fetchLeaderboard(limit = cfg.seedCount) {
  const rows = firstList(await getJson(`${DATA_API}/v1/leaderboard`, { limit }));
  return rows
    .map((r) => ({
      address: (pick(r, "proxyWallet", "wallet", "address") || "").toLowerCase(),
      name: pick(r, "userName", "name", "pseudonym") || "",
      profile_image: pick(r, "profileImage") || "",
      lb_pnl: Number(pick(r, "pnl") ?? 0),
      lb_vol: Number(pick(r, "vol", "volume") ?? 0),
    }))
    .filter((r) => r.address);
}

// ── Wallet stats from settled positions ───────────────────────
export async function fetchWalletStats(address) {
  const rows = firstList(
    await getJson(`${DATA_API}/v1/closed-positions`, { user: address, limit: 200 })
  );
  const results = rows
    .map((p) => ({
      pnl: Number(pick(p, "realizedPnl", "cashPnl", "totalPnl") ?? NaN),
      ts: pick(p, "endDate", "timestamp") ?? 0,
    }))
    .filter((r) => Number.isFinite(r.pnl));

  if (!results.length)
    return { closed_count: 0, win_rate: null, streak: 0, total_pnl: 0 };

  results.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const wins = results.filter((r) => r.pnl > 0).length;
  const firstWon = results[0].pnl > 0;
  let streak = 0;
  for (const r of results) {
    if (r.pnl > 0 === firstWon) streak++;
    else break;
  }
  return {
    closed_count: results.length,
    win_rate: wins / results.length,
    streak: firstWon ? streak : -streak,
    total_pnl: results.reduce((s, r) => s + r.pnl, 0),
  };
}

export function classify(stats) {
  if (stats.closed_count < cfg.minClosed) return "neutral";
  if (stats.streak <= -cfg.fadeStreak) return "fade";
  if (stats.win_rate !== null && stats.win_rate >= cfg.minWinRate) return "smart";
  return "neutral";
}

// ── Market resolution (market slug → events fallback) ─────────
export async function resolveMarket(urlOrSlug) {
  let slug = urlOrSlug.trim();
  const m = slug.match(/polymarket\.com\/(?:event|market)\/([^/?#]+)/);
  if (m) slug = m[1];

  let markets = firstList(await getJson(`${GAMMA_API}/markets`, { slug }));
  if (!markets.length) {
    const events = firstList(await getJson(`${GAMMA_API}/events`, { slug }));
    if (events.length) {
      markets = (events[0].markets || []).slice();
      markets.sort((a, b) => Number(b.liquidity || 0) - Number(a.liquidity || 0));
    }
  }
  if (!markets.length) return null;

  const mkt = markets[0];
  const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v) || [];
  return {
    question: pick(mkt, "question", "title") || slug,
    conditionId: pick(mkt, "conditionId", "condition_id"),
    slug: pick(mkt, "slug") || slug,
    eventSlug: pick(mkt, "eventSlug") || slug,
    image: pick(mkt, "image", "icon") || "",
    outcomes: parse(pick(mkt, "outcomes")),
    prices: parse(pick(mkt, "outcomePrices")).map(Number),
    clobTokenIds: parse(pick(mkt, "clobTokenIds", "clob_token_ids")).map(String),
    volume24h: Number(pick(mkt, "volume24hr", "volume24Hr", "volume") ?? 0),
    endDate: pick(mkt, "endDate") || null,
  };
}

// ── Market positions + smart-money summary ────────────────────
export async function fetchMarketPositions(conditionId) {
  const rows = firstList(
    await getJson(`${DATA_API}/v1/market-positions`, {
      market: conditionId,
      sortBy: "TOTAL_PNL",
      limit: 500,
    })
  );
  return rows.map((p) => ({
    address: (pick(p, "proxyWallet", "wallet", "address") || "").toLowerCase(),
    name: pick(p, "userName", "name") || null,
    outcome: pick(p, "outcome") || "?",
    avgPrice: Number(pick(p, "avgPrice") ?? NaN),
    curPrice: Number(pick(p, "curPrice", "currPrice", "currentPrice") ?? NaN),
    value: Number(pick(p, "currentValue", "value", "usdcValue") ?? 0),
  }));
}

export function smartMoneySummary(positions, whaleByAddress, minUsd = 1000) {
  const tracked = [];
  const fadeAlerts = [];
  const byOutcome = {};

  for (const p of positions) {
    if (p.value < minUsd) continue;
    const w = whaleByAddress[p.address];
    if (!w) continue;
    const entry = {
      ...p,
      whaleName: w.name || p.name || p.address.slice(0, 8),
      winRate: w.win_rate,
      streak: w.streak,
      tier: w.tier,
    };
    if (w.tier === "fade") fadeAlerts.push(entry);
    else {
      tracked.push(entry);
      byOutcome[p.outcome] = (byOutcome[p.outcome] || 0) + p.value;
    }
  }

  const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);
  let lean = null;
  if (total > 0) {
    const top = Object.entries(byOutcome).sort((a, b) => b[1] - a[1])[0];
    lean = { outcome: top[0], share: top[1] / total, totalUsd: total };
  }
  tracked.sort((a, b) => b.value - a.value);
  return { lean, tracked: tracked.slice(0, 8), fadeAlerts: fadeAlerts.slice(0, 4) };
}

// ── Trending, activity, portfolio ─────────────────────────────
export async function fetchTrending(limit = 12) {
  const rows = firstList(
    await getJson(`${GAMMA_API}/markets`, {
      active: "true",
      closed: "false",
      order: "volume24hr",
      ascending: "false",
      limit,
    })
  );
  return rows.map((mkt) => {
    const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v) || [];
    return {
      question: pick(mkt, "question") || "",
      slug: pick(mkt, "slug") || "",
      image: pick(mkt, "image", "icon") || "",
      outcomes: parse(pick(mkt, "outcomes")),
      prices: parse(pick(mkt, "outcomePrices")).map(Number),
      volume24h: Number(pick(mkt, "volume24hr") ?? 0),
    };
  });
}

export async function fetchActivity(address, limit = 20) {
  return firstList(await getJson(`${DATA_API}/activity`, { user: address, limit }));
}

export async function fetchUserPositions(address) {
  const rows = firstList(
    await getJson(`${DATA_API}/positions`, { user: address, limit: 100 })
  );
  return rows.map((p) => ({
    title: pick(p, "title", "question") || "",
    outcome: pick(p, "outcome") || "",
    avgPrice: Number(pick(p, "avgPrice") ?? NaN),
    curPrice: Number(pick(p, "curPrice", "currentPrice") ?? NaN),
    value: Number(pick(p, "currentValue", "value") ?? 0),
    pnl: Number(pick(p, "cashPnl", "totalPnl", "pnl") ?? 0),
    slug: pick(p, "slug", "eventSlug") || "",
  }));
}
