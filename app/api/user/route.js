import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { requireUser } from "@/lib/telegram";

export async function GET(req) {
  try {
    const user = requireUser(req);
    const { data } = await db().from("tg_users").select("*").eq("tg_id", user.id).maybeSingle();
    return NextResponse.json({ user: data || { tg_id: user.id, pm_address: null } });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}

export async function POST(req) {
  try {
    const user = requireUser(req);
    const { pm_address } = await req.json();
    if (pm_address && !/^0x[a-fA-F0-9]{40}$/.test(pm_address))
      return NextResponse.json({ error: "That doesn't look like a wallet address (0x…)." }, { status: 400 });
    const { error } = await db().from("tg_users").upsert({
      tg_id: user.id,
      username: user.username || null,
      pm_address: pm_address ? pm_address.toLowerCase() : null,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
