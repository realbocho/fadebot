// Polymarket public API helpers (endpoints verified against live responses).

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const cfg = {
  seedCount: Number(process.env.SEED_WALLET_COUNT || 40),
  minClosed: Number(process.env.MIN_CLOSED_POSITIONS || 10),
  minWinRate: Number(process.env.MIN_WIN_RATE || 0.55),
  fadeStreak: Number(process.env.FADE_STREAK_THRESHOLD || 5),
  maxFadeWinRate: Number(process.env.MAX_FADE_WIN_RATE || 0.35),
  xrayMinUsd: Number(process.env.XRAY_MIN_POSITION_USD || 100),
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
  // closed-positions caps at 50 per call and defaults to REALIZEDPNL DESC, so a
  // single call returns only the 50 biggest WINS — hence the uniform 100%. To
  // measure a real win rate we pull both tails: the biggest wins (DESC) and the
  // biggest losses (ASC), then dedupe. This samples the full P&L distribution.
  const q = { user: address, limit: 50, sortBy: "REALIZEDPNL" };
  const [top, bottom] = await Promise.all([
    getJson(`${DATA_API}/v1/closed-positions`, { ...q, sortDirection: "DESC" }),
    getJson(`${DATA_API}/v1/closed-positions`, { ...q, sortDirection: "ASC" }),
  ]);
  const seen = new Set();
  const rows = [...firstList(top), ...firstList(bottom)].filter((p) => {
    const id = pick(p, "asset", "conditionId") + String(pick(p, "timestamp", "endDate") ?? "");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
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
  if (stats.win_rate !== null && stats.win_rate <= cfg.maxFadeWinRate) return "fade"; // chronic loser
  if (stats.win_rate !== null && stats.win_rate >= cfg.minWinRate) return "smart";
  return "neutral";
}

// ── Market resolution (market slug → events fallback) ─────────
export async function resolveMarket(urlOrSlug) {
  const input = urlOrSlug.trim();

  // Build candidate slugs. Handles: bare slugs, /event/<e>, /event/<e>/<m>,
  // /market/<m>, /sports/... deep links, and any future polymarket.com path —
  // we simply try each path segment as a slug, last (most specific) first.
  let candidates = [];
  const urlMatch = input.match(/polymarket\.com\/([^?#]*)/);
  if (urlMatch) {
    candidates = urlMatch[1]
      .split("/")
      .map((s) => decodeURIComponent(s).trim())
      .filter((s) => s && !["event", "market", "sports", "markets"].includes(s.toLowerCase()));
    candidates.reverse(); // deepest segment first — it's the most specific
  } else {
    candidates = [input];
  }
  // Slugs contain dashes; short dashless segments are league/category names.
  const sluggy = candidates.filter((s) => s.includes("-") || candidates.length === 1);
  if (sluggy.length) candidates = sluggy;

  let markets = [];
  let requestedSlug = null;

  // 1) Try each candidate as a market slug (exact hit).
  for (const slug of candidates) {
    markets = firstList(await getJson(`${GAMMA_API}/markets`, { slug }));
    if (markets.length) { requestedSlug = slug; break; }
  }

  // 2) Fall back to event slugs; prefer the market segment from the URL if
  //    the link was /event/<event>/<market>, else the most liquid market.
  if (!markets.length) {
    for (const slug of candidates) {
      const events = firstList(await getJson(`${GAMMA_API}/events`, { slug }));
      if (!events.length) continue;
      markets = (events[0].markets || []).slice();
      const wanted = candidates.find(
        (c) => c !== slug && markets.some((mk) => pick(mk, "slug") === c)
      );
      if (wanted) {
        markets = markets.filter((mk) => pick(mk, "slug") === wanted);
      } else {
        markets.sort((a, b) => Number(b.liquidity || 0) - Number(a.liquidity || 0));
      }
      requestedSlug = slug;
      break;
    }
  }
  if (!markets.length) return null;

  const slug = requestedSlug || candidates[0] || input;
  const mkt = markets[0];
  const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v) || [];
  const eventSlug =
    pick(mkt, "eventSlug") ||
    (Array.isArray(mkt.events) && mkt.events[0]?.slug) ||
    slug;
  return {
    question: pick(mkt, "question", "title") || slug,
    conditionId: pick(mkt, "conditionId", "condition_id"),
    slug: pick(mkt, "slug") || slug,
    eventSlug,
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
  let rows = firstList(
    await getJson(`${DATA_API}/v1/market-positions`, {
      market: conditionId,
      sortBy: "TOTAL_PNL",
      limit: 500,
    })
  );
  // Live shape (verified): grouped per outcome token → [{ token, positions: [...] }]
  if (rows.length && Array.isArray(rows[0]?.positions)) {
    rows = rows.flatMap((g) => g.positions || []);
  }
  return rows.map((p) => {
    const avgPrice = Number(pick(p, "avgPrice") ?? NaN);
    const curPrice = Number(pick(p, "curPrice", "currPrice", "currentPrice") ?? NaN);
    const size = Number(pick(p, "size", "shares", "quantity") ?? NaN);

    // Some deployments of this endpoint omit currentValue — derive it.
    let value = Number(pick(p, "currentValue", "value", "usdcValue") ?? NaN);
    if (!Number.isFinite(value) && Number.isFinite(size) && Number.isFinite(curPrice))
      value = size * curPrice;
    if (!Number.isFinite(value)) value = 0;

    const cashPnl = Number(pick(p, "cashPnl") ?? 0);
    let totalPnl = Number(pick(p, "totalPnl", "cashPnl") ?? NaN);
    if (!Number.isFinite(totalPnl)) {
      const realized = Number(pick(p, "realizedPnl") ?? 0);
      const unrealized =
        Number.isFinite(size) && Number.isFinite(curPrice) && Number.isFinite(avgPrice)
          ? (curPrice - avgPrice) * size
          : 0;
      totalPnl = realized + unrealized;
    }

    return {
      address: (pick(p, "proxyWallet", "wallet", "address") || "").toLowerCase(),
      name: pick(p, "userName", "name", "pseudonym") || null,
      outcome: pick(p, "outcome") || "?",
      avgPrice,
      curPrice,
      value,
      totalPnl,
      cashPnl,
    };
  });
}

export function smartMoneySummary(positions, whaleByAddress, minUsd = cfg.xrayMinUsd) {
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
      conditionId: pick(mkt, "conditionId", "condition_id") || null,
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
    await getJson(`${DATA_API}/positions`, { user: address, limit: 100, sizeThreshold: 0.1 })
  );
  return rows.map((p) => ({
    title: pick(p, "title", "question") || "",
    outcome: pick(p, "outcome") || "",
    avgPrice: Number(pick(p, "avgPrice") ?? NaN),
    curPrice: Number(pick(p, "curPrice", "currentPrice") ?? NaN),
    value: Number(pick(p, "currentValue", "value") ?? 0),
    pnl: Number(pick(p, "cashPnl", "totalPnl", "pnl") ?? 0),
    slug: pick(p, "slug", "eventSlug") || "",
    // Identity fields — TradeSheet needs these to find, sell, and redeem
    // the position. Dropping them silently disabled Sell/Claim.
    asset: String(pick(p, "asset", "tokenId", "token_id") ?? ""),
    size: Number(pick(p, "size") ?? 0),
    conditionId: pick(p, "conditionId", "condition_id") || "",
    redeemable: Boolean(pick(p, "redeemable")),
    negativeRisk: Boolean(pick(p, "negativeRisk", "negRisk")),
  }));
}


// ── Loser harvest: find big wallets deep underwater in busy markets ──
// The PnL leaderboard only surfaces winners; fade candidates hide inside
// market position lists as large holders with deeply negative total PnL.
export async function harvestLoserCandidates({
  markets = 10,
  minPositionUsd = 2000,
  maxLossPnl = -5000,
  cap = 25,
} = {}) {
  const trending = await fetchTrending(markets);
  const seen = new Set();
  const candidates = [];
  const diag = [];

  for (const m of trending) {
    if (!m.conditionId) continue;
    let positions;
    try {
      positions = await fetchMarketPositions(m.conditionId);
    } catch (e) {
      diag.push({ slug: m.slug, error: e.message });
      continue;
    }

    let hits = 0;
    let worst = 0;
    for (const p of positions) {
      // Loser signal: deep negative on either realized-total OR current bag
      // (sortBy=TOTAL_PNL window is winners-first, so bagholders — big
      // unrealized losses — are often the only losers visible in it).
      const loss = Math.min(Number(p.totalPnl ?? 0), Number(p.cashPnl ?? 0));
      worst = Math.min(worst, loss);
      if (p.value >= minPositionUsd && loss <= maxLossPnl && !seen.has(p.address)) {
        seen.add(p.address);
        hits++;
        candidates.push({
          address: p.address,
          name: p.name || "",
          profile_image: "",
          lb_pnl: loss,
          lb_vol: null,
        });
      }
    }
    diag.push({ slug: m.slug, positions: positions.length, hits, worstLossSeen: Math.round(worst) });
    if (candidates.length >= cap) break;
  }
  return { candidates: candidates.slice(0, cap), diag };
}


// ── Fallback x-ray for markets with no tracked whales. Tiered so thin/longshot
// markets (penny prices → tiny position values) still render something real:
//   winners: profitable holders ≥ xrayMinUsd
//   holders: largest holders ≥ $10 (when nobody is in profit / values are tiny)
export function marketNativeSummary(positions, minUsd = cfg.xrayMinUsd, top = 8) {
  const build = (list, sortKey) => {
    const byOutcome = {};
    for (const p of list) byOutcome[p.outcome] = (byOutcome[p.outcome] || 0) + p.value;
    const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);
    let lean = null;
    if (total > 0) {
      const [outcome, usd] = Object.entries(byOutcome).sort((a, b) => b[1] - a[1])[0];
      lean = { outcome, share: usd / total, totalUsd: total };
    }
    const tracked = list
      .sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0))
      .slice(0, top)
      .map((p) => ({
        ...p,
        whaleName: p.name || p.address.slice(0, 8),
        winRate: null,
        streak: 0,
        tier: "market",
      }));
    return { lean, tracked, fadeAlerts: [] };
  };

  const winners = positions.filter((p) => p.value >= minUsd && p.totalPnl > 0);
  if (winners.length) return { ...build(winners, "totalPnl"), mode: "winners" };

  const holders = positions.filter((p) => p.value >= 10);
  if (holders.length) return { ...build(holders, "value"), mode: "holders" };

  return { lean: null, tracked: [], fadeAlerts: [], mode: "empty" };
}

// Raw sample for debugging field-name mismatches on live data.
export async function fetchMarketPositionsRaw(conditionId, limit = 2) {
  const qs = new URLSearchParams({ market: conditionId, sortBy: "TOTAL_PNL", limit });
  const res = await fetch(DATA_API + "/v1/market-positions?" + qs);
  if (!res.ok) return { status: res.status, body: (await res.text()).slice(0, 300) };
  return res.json();
}
