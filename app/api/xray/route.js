import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { resolveMarket, fetchMarketPositions, smartMoneySummary, marketNativeSummary } from "@/lib/polymarket";

export async function GET(req) {
  const q = new URL(req.url).searchParams.get("q");
  if (!q) return NextResponse.json({ error: "Missing market URL or slug." }, { status: 400 });

  try {
    const market = await resolveMarket(q);
    if (!market?.conditionId)
      return NextResponse.json({ error: "Market not found. Paste a Polymarket link." }, { status: 404 });

    const [{ data: whales }, positions] = await Promise.all([
      db().from("whales").select("*"),
      fetchMarketPositions(market.conditionId),
    ]);
    const byAddr = Object.fromEntries((whales || []).map((w) => [w.address, w]));
    let summary = smartMoneySummary(positions, byAddr);
    let source = "tracked";
    if (!summary.lean && !summary.fadeAlerts.length) {
      summary = marketNativeSummary(positions);
      source = "market";
    }

    // Divergence: smart-money lean share vs crowd price for the same outcome
    let divergence = null;
    if (summary.lean && market.outcomes.length) {
      const idx = market.outcomes.findIndex(
        (o) => o.toLowerCase() === summary.lean.outcome.toLowerCase()
      );
      if (idx >= 0 && Number.isFinite(market.prices[idx])) {
        divergence = {
          outcome: summary.lean.outcome,
          crowd: market.prices[idx],
          smart: summary.lean.share,
          gap: summary.lean.share - market.prices[idx],
        };
      }
    }
    return NextResponse.json({ market, summary, divergence, source });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
