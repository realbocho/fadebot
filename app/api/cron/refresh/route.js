import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import {
  fetchLeaderboard, fetchWalletStats, classify, harvestLoserCandidates,
} from "@/lib/polymarket";

export const maxDuration = 60;

function authorized(req) {
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

// Rebuild the whale DB.
//   default        → leaderboard winners (smart-money seed)
//   ?mode=losers   → harvest big underwater wallets from busy markets (fade seed)
// Supports ?offset=&limit= batching if a run exceeds function time.
export async function GET(req) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "winners";
  const offset = Number(url.searchParams.get("offset") || 0);
  const limit = Number(url.searchParams.get("limit") || 0);

  try {
    let diag = null;
    let seeds;
    if (mode === "losers") {
      const opts = {};
      for (const [qk, ok] of [["markets","markets"],["minUsd","minPositionUsd"],["maxPnl","maxLossPnl"],["cap","cap"]]) {
        const v = url.searchParams.get(qk);
        if (v !== null) opts[ok] = Number(v);
      }
      const h = await harvestLoserCandidates(opts);
      seeds = h.candidates;
      diag = h.diag;
    } else {
      seeds = await fetchLeaderboard();
    }
    if (limit) seeds = seeds.slice(offset, offset + limit);

    let ok = 0, failed = 0, fade = 0;
    for (const seed of seeds) {
      try {
        const stats = await fetchWalletStats(seed.address);
        const tier = classify(stats);
        if (tier === "fade") fade++;
        const row = { ...seed, ...stats, tier, updated_at: new Date().toISOString() };
        const { error } = await db().from("whales").upsert(row);
        if (error) throw error;
        ok++;
      } catch (e) {
        console.error("refresh failed", seed.address, e.message);
        failed++;
      }
      await new Promise((r) => setTimeout(r, 200)); // polite pacing
    }
    const out = { mode, ok, failed, fade, batch: { offset, limit: limit || seeds.length } };
    if (url.searchParams.get("debug") === "1" && diag) out.diag = diag;
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
