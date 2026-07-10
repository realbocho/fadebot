import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { requireUser } from "@/lib/telegram";

export async function GET(req) {
  try {
    const { data: whales, error } = await db()
      .from("whales")
      .select("*")
      .order("win_rate", { ascending: false, nullsFirst: false });
    if (error) throw error;

    let following = [];
    try {
      const user = requireUser(req);
      const { data } = await db().from("follows").select("whale_address").eq("tg_id", user.id);
      following = (data || []).map((f) => f.whale_address);
    } catch { /* browsing without Telegram context is fine */ }

    return NextResponse.json({ whales: whales || [], following });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
