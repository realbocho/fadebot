import { NextResponse } from "next/server";
import { fetchWalletStats } from "@/lib/polymarket";
import { db } from "@/lib/supabase";

const DATA_API = "https://data-api.polymarket.com";

// Diagnostic: /api/debug-wallet  (no address needed — grabs a stored whale)
// or /api/debug-wallet?address=0x...
// Shows the raw closed-positions sample alongside our computed stats, so we can
// see exactly why win rates were coming out uniformly 100%.
export async function GET(req) {
  let address = new URL(req.url).searchParams.get("address");

  // No address? Pull the first whale from the DB so you don't have to find one.
  if (!address) {
    try {
      const { data } = await db().from("whales").select("address,name").limit(1);
      address = data?.[0]?.address;
    } catch { /* fall through */ }
  }
  if (!address)
    return NextResponse.json({ error: "no address and no whales in DB" }, { status: 400 });

  let raw = null, rawError = null, rawAsc = null;
  try {
    const res = await fetch(`${DATA_API}/v1/closed-positions?user=${address}&limit=10`);
    raw = res.ok ? await res.json() : { status: res.status, body: (await res.text()).slice(0, 400) };
    // Also fetch ascending — if losses exist, they surface as the most-negative
    // realizedPnl here. If ASC still shows only positives, this endpoint simply
    // doesn't return losing positions (winners-only).
    const resAsc = await fetch(`${DATA_API}/v1/closed-positions?user=${address}&limit=10&sortBy=REALIZEDPNL&sortDirection=ASC`);
    rawAsc = resAsc.ok ? await resAsc.json() : { status: resAsc.status };
  } catch (e) {
    rawError = e.message;
  }

  const slim = (arr) =>
    Array.isArray(arr)
      ? arr.map((p) => ({ title: p.title, realizedPnl: p.realizedPnl, outcome: p.outcome }))
      : arr;

  let stats = null, statsError = null;
  try {
    stats = await fetchWalletStats(address);
  } catch (e) {
    statsError = e.message;
  }

  return NextResponse.json({
    address,
    computedStats: stats,
    statsError,
    topByPnl: slim(raw),
    bottomByPnl: slim(rawAsc),
    rawError,
  });
}
