import { NextResponse } from "next/server";
import { fetchWalletStats } from "@/lib/polymarket";

const DATA_API = "https://data-api.polymarket.com";

// Diagnostic: /api/debug-wallet?address=0x...
// Shows the raw closed-positions sample alongside our computed stats, so we can
// see exactly why win rates were coming out uniformly 100%.
export async function GET(req) {
  const address = new URL(req.url).searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  let raw = null, rawError = null;
  try {
    const res = await fetch(`${DATA_API}/v1/closed-positions?user=${address}&limit=5`);
    raw = res.ok ? await res.json() : { status: res.status, body: (await res.text()).slice(0, 400) };
  } catch (e) {
    rawError = e.message;
  }

  // Reduce raw to just the P&L-relevant fields so it's readable.
  const sample = Array.isArray(raw)
    ? raw.map((p) => ({
        title: p.title,
        cashPnl: p.cashPnl,
        realizedPnl: p.realizedPnl,
        totalPnl: p.totalPnl,
        currentValue: p.currentValue,
        initialValue: p.initialValue,
        redeemable: p.redeemable,
        outcome: p.outcome,
      }))
    : raw;

  let stats = null, statsError = null;
  try {
    stats = await fetchWalletStats(address);
  } catch (e) {
    statsError = e.message;
  }

  return NextResponse.json({ address, computedStats: stats, statsError, rawSample: sample, rawError });
}
