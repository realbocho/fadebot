import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { fetchActivity, pick } from "@/lib/polymarket";
import { sendMessage } from "@/lib/telegram";

export const maxDuration = 60;

function authorized(req) {
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

function narrative(whale, ev) {
  const usd = Number(pick(ev, "usdcSize", "size") || 0);
  const outcome = pick(ev, "outcome") || "?";
  const price = Number(pick(ev, "price") || 0);
  const title = pick(ev, "title") || "a market";
  const slug = pick(ev, "eventSlug", "slug") || "";

  let hook = "";
  if (whale.tier === "fade" && whale.streak < 0)
    hook = ` This wallet is on a ${-whale.streak}-loss streak. Fade?`;
  else if (whale.win_rate >= 0.7)
    hook = ` This wallet wins ${Math.round(whale.win_rate * 100)}% of settled positions.`;

  const link = slug ? `\nhttps://polymarket.com/event/${slug}` : "";
  return `🐋 ${whale.name || whale.address.slice(0, 8)} just placed $${usd.toLocaleString()} on ${outcome} at ${price.toFixed(2)} — "${title}".${hook}${link}`;
}

// Poll followed whales' activity → push new BUY trades to followers.
export async function GET(req) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // Only whales that at least one person follows
    const { data: follows } = await db().from("follows").select("whale_address, tg_id");
    if (!follows?.length) return NextResponse.json({ checked: 0, sent: 0 });

    const followers = {};
    for (const f of follows)
      (followers[f.whale_address] ||= []).push(f.tg_id);

    const addresses = Object.keys(followers);
    const { data: whales } = await db().from("whales").select("*").in("address", addresses);
    const whaleByAddr = Object.fromEntries((whales || []).map((w) => [w.address, w]));

    let sent = 0;
    for (const address of addresses) {
      const whale = whaleByAddr[address];
      if (!whale) continue;

      let events;
      try { events = await fetchActivity(address, 20); }
      catch (e) { console.error("activity failed", address, e.message); continue; }

      for (const ev of events) {
        const type = String(pick(ev, "type") || "").toUpperCase();
        const side = String(pick(ev, "side") || "").toUpperCase();
        if (type !== "TRADE" || side !== "BUY") continue;

        const id = String(pick(ev, "transactionHash", "id") || "");
        if (!id) continue;

        // idempotent: primary-key insert fails on duplicates
        const { error } = await db().from("seen_events").insert({ id });
        if (error) continue; // already seen

        const text = narrative(whale, ev);
        for (const tgId of followers[address]) {
          if (await sendMessage(tgId, text)) sent++;
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return NextResponse.json({ checked: addresses.length, sent });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
