"use client";

import { useEffect, useState } from "react";
import { useApi } from "../page";
import TradeSheet from "./TradeSheet";

const fmtUsd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (n) => Math.round(n * 100) + "%";

function DivergenceGauge({ d }) {
  const crowd = Math.min(Math.max(d.crowd, 0), 1) * 100;
  const smart = Math.min(Math.max(d.smart, 0), 1) * 100;
  const left = Math.min(crowd, smart);
  const width = Math.abs(smart - crowd);
  return (
    <div className="gauge">
      <div className="gauge-track" role="img"
        aria-label={`Crowd prices ${d.outcome} at ${pct(d.crowd)}; smart money leans ${pct(d.smart)}`}>
        <div className="gauge-gap" style={{ left: `${left}%`, width: `${width}%` }} />
        <div className="gauge-marker crowd" style={{ left: `${crowd}%` }} />
        <div className="gauge-marker smart" style={{ left: `${smart}%` }} />
      </div>
      <div className="gauge-labels">
        <span className="crowd-label">CROWD {pct(d.crowd)} {d.outcome}</span>
        <span className="smart-label">WHALES {pct(d.smart)} {d.outcome}</span>
      </div>
      <div className="gauge-gapnum">
        {d.gap >= 0 ? "+" : ""}{pct(d.gap)}
        <small>DIVERGENCE</small>
      </div>
    </div>
  );
}

function XrayCard({ data, onTrade }) {
  const { market, summary, divergence } = data;

  // Copy = buy the smart-money outcome; Fade = buy the other side.
  const pickTarget = (mode) => {
    const outcomes = market.outcomes || [];
    const tokens = market.clobTokenIds || [];
    if (outcomes.length < 2 || tokens.length < 2) return null;
    const leanOutcome = summary.lean?.outcome || outcomes[0];
    let idx = outcomes.findIndex((o) => o.toLowerCase() === leanOutcome.toLowerCase());
    if (idx < 0) idx = 0;
    if (mode === "fade") idx = idx === 0 ? 1 : 0;
    return {
      market, mode,
      outcome: outcomes[idx],
      tokenID: tokens[idx],
      refPrice: market.prices?.[idx],
    };
  };

  const trade = (mode) => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
    const target = pickTarget(mode);
    if (target) onTrade(target);
    else
      window.Telegram?.WebApp?.openLink?.(
        `https://polymarket.com/event/${market.eventSlug || market.slug}`
      );
  };

  return (
    <div className="card">
      <div className="eyebrow">Smart money x-ray</div>
      <h3>{market.question}</h3>

      {divergence ? (
        <DivergenceGauge d={divergence} />
      ) : summary.lean ? (
        <p className="empty">
          Whales lean {pct(summary.lean.share)} {summary.lean.outcome} ({fmtUsd(summary.lean.totalUsd)} tracked)
        </p>
      ) : (
        <p className="empty">No tracked whales hold this market above $1K yet.</p>
      )}

      {summary.tracked.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 12 }}>Tracked positions</div>
          {summary.tracked.map((e, i) => (
            <div className="row" key={i}>
              <div className="avatar" aria-hidden>🐋</div>
              <div className="who">
                <b>{e.whaleName}</b>
                <span>
                  entry {Number.isFinite(e.avgPrice) ? e.avgPrice.toFixed(2) : "–"} → now{" "}
                  {Number.isFinite(e.curPrice) ? e.curPrice.toFixed(2) : "–"}
                </span>
              </div>
              <div className="nums">
                <b>{e.outcome} {fmtUsd(e.value)}</b>
                {e.winRate != null && <span>WR {pct(e.winRate)}</span>}
              </div>
            </div>
          ))}
        </>
      )}

      {summary.fadeAlerts.map((e, i) => (
        <div className="alert-fade" key={i}>
          <b>FADE SIGNAL</b> — {e.whaleName} is on a {-e.streak}-loss streak and holds{" "}
          {e.outcome} {fmtUsd(e.value)}.
        </div>
      ))}

      <div className="btn-pair">
        <button className="btn primary" onClick={() => trade("copy")}>
          Copy whales
        </button>
        <button className="btn danger" onClick={() => trade("fade")}>
          Fade whales
        </button>
      </div>
      <button className="view-link" onClick={() =>
        window.Telegram?.WebApp?.openLink?.(`https://polymarket.com/event/${market.eventSlug || market.slug}`)}>
        View on Polymarket ↗
      </button>
    </div>
  );
}

export default function MarketsTab({ startSlug }) {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [xray, setXray] = useState(null);
  const [trending, setTrending] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tradeTarget, setTradeTarget] = useState(null);
  const [error, setError] = useState("");

  const runXray = async (q) => {
    if (!q) return;
    setLoading(true); setError(""); setXray(null);
    try {
      setXray(await api(`/api/xray?q=${encodeURIComponent(q)}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api("/api/trending").then((r) => setTrending(r.markets || [])).catch(() => {});
    if (startSlug) runXray(startSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSlug]);

  return (
    <div>
      <div className="search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runXray(query)}
          placeholder="Paste a Polymarket link…"
          aria-label="Polymarket market link"
        />
        <button className="btn primary" onClick={() => runXray(query)} disabled={loading}>
          X-ray
        </button>
      </div>

      {loading && <div className="loading">Scanning whale positions…</div>}
      {error && <div className="err">{error}</div>}
      {xray && <XrayCard data={xray} onTrade={setTradeTarget} />}

      <div className="section-title">Trending — tap to x-ray</div>
      <div className="grid">
        {trending.map((m) => (
          <button className="tile" key={m.slug} onClick={() => runXray(m.slug)}>
            {m.image ? <img src={m.image} alt="" /> : null}
            <div className="q">{m.question}</div>
            <div className="p">
              {m.outcomes?.[0] && Number.isFinite(m.prices?.[0]) ? (
                <><b>{Math.round(m.prices[0] * 100)}¢</b> {m.outcomes[0]}</>
              ) : ("—")}
              {m.volume24h ? ` · ${fmtUsd(m.volume24h)} 24h` : ""}
            </div>
          </button>
        ))}
      </div>
      {tradeTarget && <TradeSheet target={tradeTarget} onClose={() => setTradeTarget(null)} />}

      {!trending.length && !loading && (
        <p className="empty">Trending markets load here. Pull to refresh if empty.</p>
      )}
    </div>
  );
}
