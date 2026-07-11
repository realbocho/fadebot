import { NextResponse } from "next/server";
import { buildHmacSignature } from "@polymarket/builder-signing-sdk";
import { verifyInitData } from "@/lib/telegram";

// Remote builder signing endpoint (official builder pattern).
// The relayer SDK on the client POSTs {method, path, body, timestamp} here and
// gets back HMAC headers built from our builder credentials — which never
// leave the server. Auth: the SDK's Bearer token carries Telegram initData,
// so only real users of our mini app can obtain signatures (this closes the
// security hole flagged in Polymarket's reference examples).
export async function POST(req) {
  const key = process.env.BUILDER_API_KEY;
  const secret = process.env.BUILDER_SECRET;
  const passphrase = process.env.BUILDER_PASS_PHRASE;
  if (!key || !secret || !passphrase)
    return NextResponse.json({ error: "Builder credentials not configured." }, { status: 500 });

  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!verifyInitData(bearer))
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const { method, path, body, timestamp } = await req.json();
    if (!method || !path)
      return NextResponse.json({ error: "Missing method/path." }, { status: 400 });

    const ts = Number(timestamp ?? Math.floor(Date.now() / 1000));
    const signature = buildHmacSignature(secret, ts, method, path, body);

    return NextResponse.json({
      POLY_BUILDER_API_KEY: key,
      POLY_BUILDER_TIMESTAMP: String(ts),
      POLY_BUILDER_PASSPHRASE: passphrase,
      POLY_BUILDER_SIGNATURE: signature,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
