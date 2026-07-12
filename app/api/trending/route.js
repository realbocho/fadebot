import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { fetchTrending } from "@/lib/polymarket";

export const revalidate = 120;

export async function GET() {
  try {
    return NextResponse.json({ markets: await fetchTrending(12) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
