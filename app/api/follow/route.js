import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { requireUser } from "@/lib/telegram";
import { fetchActivity, pick } from "@/lib/polymarket";

export async function POST(req) {
  try {
    const user = requireUser(req);
    const { address } = await req.json();
    if (!address) return NextResponse.json({ error: "Missing whale address." }, { status: 400 });

    await db().from("tg_users").upsert({ tg_id: user.id, username: user.username || null });

    const { data: existing } = await db()
      .from("follows").select("tg_id")
      .eq("tg_id", user.id).eq("whale_address", address).maybeSingle();

    if (existing) {
      await db().from("follows").delete().eq("tg_id", user.id).eq("whale_address", address);
      return NextResponse.json({ following: false });
    }
    const { error } = await db().from("follows").insert({ tg_id: user.id, whale_address: address });
    if (error) throw error;

    // Baseline: mark this whale's existing trades as already-seen so following
    // never triggers a flood of alerts for past activity. Only trades that
    // happen AFTER this point will notify. Best-effort — don't block the follow.
    try {
      const events = await fetchActivity(address, 40);
      const rows = events
        .map((ev) => String(pick(ev, "transactionHash", "id") || ""))
        .filter(Boolean)
        .map((id) => ({ id }));
      if (rows.length) await db().from("seen_events").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    } catch { /* baseline is best-effort */ }

    return NextResponse.json({ following: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
