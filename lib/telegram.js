import crypto from "crypto";

// Verify Telegram WebApp initData (HMAC per Telegram docs). Returns user or null.
export function verifyInitData(initData) {
  try {
    if (!initData) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheck = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secret = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.BOT_TOKEN)
      .digest();
    const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calc !== hash) return null;
    // Reject stale auth (24h)
    const authDate = Number(params.get("auth_date") || 0);
    if (Date.now() / 1000 - authDate > 86400) return null;
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

export function requireUser(req) {
  const user = verifyInitData(req.headers.get("x-tg-init-data") || "");
  if (!user?.id) throw Object.assign(new Error("Open this app inside Telegram."), { status: 401 });
  return user;
}

export async function sendMessage(chatId, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    }
  );
  return res.ok;
}
