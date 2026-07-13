"use client";

import { useEffect, useState } from "react";
import { useApi } from "../page";

const pct = (n) => (n == null ? "–" : Math.round(n * 100) + "%");
const fmtUsd = (n) => "$" + Math.round(n).toLocaleString("en-US");

function WhaleRow({ w, following, onToggle, onOpen }) {
  return (
    <div className="row whale-row" onClick={() => onOpen(w)} style={{ cursor: "pointer" }}>
      <div className="avatar">
        {w.profile_image ? <img src={w.profile_image} alt="" /> : "🐋"}
      </div>
      <div className="who">
        <b>{w.name || w.address.slice(0, 10) + "…"}</b>
        <span>
          WR {pct(w.win_rate)} · {w.closed_count} settled ·{" "}
          {w.streak > 0 ? `${w.streak}W streak` : w.streak < 0 ? `${-w.streak}L streak` : "no streak"}
        </span>
        {w.total_pnl != null && (
          <span className={w.total_pnl >= 0 ? "pnl-pos" : "pnl-neg"} style={{ fontWeight: 600 }}>
            {w.total_pnl >= 0 ? "+" : "−"}{fmtUsd(Math.abs(w.total_pnl))} total profit
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
        <span className={`badge ${w.tier}`}>{w.tier === "smart" ? "APEX" : w.tier === "fade" ? "WOUNDED" : "LURKING"}</span>
        <button
          className={`btn small ${following ? "ghost" : "primary"}`}
          onClick={(e) => { e.stopPropagation(); onToggle(w.address); }}
        >
          {following ? "🎯 Tracking" : "Track"}
        </button>
      </div>
    </div>
  );
}

// Detail view: a single whale's current open bets. Tapping a bet opens that
// market's hunt screen (WIN/LOSE) via onOpenMarket(slug).
function WhaleDetail({ whale, api, onBack, onOpenMarket }) {
  const [positions, setPositions] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/whale-positions?address=${whale.address}`)
      .then((r) => setPositions(r.positions || []))
      .catch((e) => setError(e.message));
  }, [api, whale.address]);

  return (
    <div>
      <button className="view-link" style={{ textAlign: "left", marginBottom: 8 }} onClick={onBack}>
        ← Back to the pod
      </button>

      <div className="card">
        <div className="row" style={{ cursor: "default" }}>
          <div className="avatar">{whale.profile_image ? <img src={whale.profile_image} alt="" /> : "🐋"}</div>
          <div className="who">
            <b>{whale.name || whale.address.slice(0, 10) + "…"}</b>
            <span>
              WR {pct(whale.win_rate)} · {whale.closed_count} settled ·{" "}
              {whale.streak > 0 ? `${whale.streak}W streak` : whale.streak < 0 ? `${-whale.streak}L streak` : "no streak"}
            </span>
            {whale.total_pnl != null && (
              <span className={whale.total_pnl >= 0 ? "pnl-pos" : "pnl-neg"} style={{ fontWeight: 600 }}>
                {whale.total_pnl >= 0 ? "+" : "−"}{fmtUsd(Math.abs(whale.total_pnl))} total profit
              </span>
            )}
          </div>
          <span className={`badge ${whale.tier}`}>{whale.tier === "smart" ? "APEX" : whale.tier === "fade" ? "WOUNDED" : "LURKING"}</span>
        </div>
      </div>

      <div className="section-title">🎯 Current bets — tap one to hunt</div>

      {error && <div className="err">{error}</div>}
      {positions === null && <div className="loading">📡 Pulling this whale's bets…</div>}
      {positions?.length === 0 && <p className="empty">This whale has no open bets right now.</p>}

      {positions?.map((p, i) => (
        <div
          className="card bet-card"
          key={i}
          onClick={() => p.slug && onOpenMarket(p.slug)}
          style={{ cursor: p.slug ? "pointer" : "default", marginBottom: 8 }}
        >
          <div className="bet-title">{p.title}</div>
          <div className="bet-meta">
            <span className="bet-side">🐋 Betting <b>{p.outcome}</b></span>
            <span className="bet-value">{fmtUsd(p.value)}</span>
          </div>
          <div className="bet-sub">
            entry {Number.isFinite(p.avgPrice) ? p.avgPrice.toFixed(2) : "–"} → now {Number.isFinite(p.curPrice) ? p.curPrice.toFixed(2) : "–"}
            {p.slug && <span className="bet-cta"> · tap to bet on this whale →</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WhalesTab({ onOpenMarket }) {
  const api = useApi();
  const [whales, setWhales] = useState([]);
  const [following, setFollowing] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openWhale, setOpenWhale] = useState(null);

  useEffect(() => {
    api("/api/whales")
      .then((r) => { setWhales(r.whales || []); setFollowing(r.following || []); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [api]);

  const toggle = async (address) => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
    try {
      const r = await api("/api/follow", { method: "POST", body: JSON.stringify({ address }) });
      setFollowing((f) => (r.following ? [...f, address] : f.filter((a) => a !== address)));
    } catch (e) {
      setError(e.message);
    }
  };

  const smart = whales.filter((w) => w.tier === "smart");
  const fade = whales.filter((w) => w.tier === "fade");
  const rest = whales.filter((w) => w.tier === "neutral");

  if (loading) return <div className="loading">📡 Locating whales…</div>;

  if (openWhale) {
    return (
      <WhaleDetail
        whale={openWhale}
        api={api}
        onBack={() => setOpenWhale(null)}
        onOpenMarket={(slug) => onOpenMarket?.(slug)}
      />
    );
  }

  const Section = ({ title, list }) =>
    list.length > 0 ? (
      <>
        <div className="section-title">{title}</div>
        <div className="card">
          {list.map((w) => (
            <WhaleRow
              key={w.address}
              w={w}
              following={following.includes(w.address)}
              onToggle={toggle}
              onOpen={setOpenWhale}
            />
          ))}
        </div>
      </>
    ) : null;

  return (
    <div>
      {error && <div className="err">{error}</div>}
      {!whales.length && (
        <p className="empty">
          No whales spotted yet. Run the refresh cron once after deploy —
          see README → “First run”.
        </p>
      )}
      <Section title="🐋 Apex whales — the ones winning" list={smart} />
      <Section title="🩸 Wounded whales — on cold streaks" list={fade} />
      <Section title="🌊 In the water" list={rest} />
    </div>
  );
}
