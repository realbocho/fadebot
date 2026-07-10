import { NextResponse } from "next/server";

// Compliance gate: the app is not offered in blocked regions.
const BLOCKED = (process.env.BLOCKED_COUNTRIES || "KR")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

export function middleware(req) {
  const { pathname } = req.nextUrl;

  // Crons run from Vercel infra (no user geo) and are secret-gated in-route.
  if (
    pathname.startsWith("/restricted") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const country = (req.headers.get("x-vercel-ip-country") || "").toUpperCase();
  if (country && BLOCKED.includes(country)) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json(
        { error: "FadeBot is not available in your region." },
        { status: 451 }
      );
    }
    return NextResponse.rewrite(new URL("/restricted", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
