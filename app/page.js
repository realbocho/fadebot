"use client";

import { useEffect, useState, useCallback } from "react";
import MarketsTab from "./components/MarketsTab";
import WhalesTab from "./components/WhalesTab";
import PortfolioTab from "./components/PortfolioTab";
import AlertsTab from "./components/AlertsTab";

// Shared fetch that attaches Telegram auth
export function useApi() {
  return useCallback(async (path, options = {}) => {
    const initData =
      typeof window !== "undefined" ? window.Telegram?.WebApp?.initData || "" : "";
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-tg-init-data": initData,
        ...(options.headers || {}),
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }, []);
}

const TABS = [
  { id: "markets", label: "MARKETS", ico: "◎" },
  { id: "whales", label: "WHALES", ico: "🐋" },
  { id: "portfolio", label: "PORTFOLIO", ico: "▤" },
  { id: "alerts", label: "ALERTS", ico: "▲" },
];

export default function App() {
  const [tab, setTab] = useState("markets");
  // Deep-link payload: t.me/YourBot/app?startapp=<market-slug>
  const [startSlug, setStartSlug] = useState(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#0A0F1C");
    tg.setBackgroundColor?.("#0A0F1C");
    const param = tg.initDataUnsafe?.start_param;
    if (param) setStartSlug(param);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <span className="ping" aria-hidden />
        <span className="logo">
          FADE<em>BOT</em>
        </span>
        <span className="tagline">smart money x-ray</span>
      </header>

      {tab === "markets" && <MarketsTab startSlug={startSlug} />}
      {tab === "whales" && <WhalesTab />}
      {tab === "portfolio" && <PortfolioTab />}
      {tab === "alerts" && <AlertsTab />}

      <p className="disclaimer">
        Data from Polymarket public APIs. FadeBot is an information and entertainment
        tool — not financial advice. Trading involves risk of loss. Not available in
        restricted regions.
      </p>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => {
              setTab(t.id);
              window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.();
            }}
          >
            <span className="ico" aria-hidden>{t.ico}</span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
