import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { requireUser } from "@/lib/telegram";
import { fetchUserPositions } from "@/lib/polymarket";

export async function GET(req) {
  try {
    const user = requireUser(req);
    const { data } = await db().from("tg_users").select("pm_address").eq("tg_id", user.id).maybeSingle();
    if (!data?.pm_address) return NextResponse.json({ linked: false, positions: [] });
    const positions = await fetchUserPositions(data.pm_address);
    return NextResponse.json({ linked: true, address: data.pm_address, positions });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
