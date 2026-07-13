import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { db } from "@/lib/supabase";
import { fetchUserPositions } from "@/lib/polymarket";

// A specific whale's current open bets: /api/whale-positions?address=0x...
// Reuses fetchUserPositions (same call the Bounty tab uses for the user's own
// wallet) but points it at any whale. Sorted biggest-position first.
export async function GET(req) {
  const address = new URL(req.url).searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  try {
    const [positions, whaleRow] = await Promise.all([
      fetchUserPositions(address),
      db().from("whales").select("*").eq("address", address).maybeSingle().then((r) => r.data),
    ]);

    // Only positions still worth showing, biggest first.
    const open = positions
      .filter((p) => p.value >= 1)
      .sort((a, b) => b.value - a.value);

    return NextResponse.json({ address, whale: whaleRow || null, positions: open });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
