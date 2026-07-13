"use client";

import { useEffect, useState } from "react";
import { useApi } from "../page";

const pct = (n) => (n == null ? "–" : Math.round(n * 100) + "%");
const fmtUsd = (n) => "$" + Math.round(n).toLocaleString("en-US");

function WhaleRow({ w, following, onToggle }) {
  return (
    <div className="row">
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
      <span className={`badge ${w.tier}`}>{w.tier}</span>
      <button
        className={`btn small ${following ? "ghost" : "primary"}`}
        onClick={() => onToggle(w.address)}
      >
        {following ? "Following" : "Follow"}
      </button>
    </div>
  );
}

export default function WhalesTab() {
  const api = useApi();
  const [whales, setWhales] = useState([]);
  const [following, setFollowing] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  if (loading) return <div className="loading">Loading the whale league…</div>;

  return (
    <div>
      {error && <div className="err">{error}</div>}
      {!whales.length && (
        <p className="empty">
          The whale league is empty. Run the refresh cron once after deploy —
          see README → “First run”.
        </p>
      )}

      {smart.length > 0 && (
        <>
          <div className="section-title">Smart money — copy candidates</div>
          <div className="card">
            {smart.map((w) => (
              <WhaleRow key={w.address} w={w} following={following.includes(w.address)} onToggle={toggle} />
            ))}
          </div>
        </>
      )}

      {fade.length > 0 && (
        <>
          <div className="section-title">Fade watch — losing streaks</div>
          <div className="card">
            {fade.map((w) => (
              <WhaleRow key={w.address} w={w} following={following.includes(w.address)} onToggle={toggle} />
            ))}
          </div>
        </>
      )}

      {rest.length > 0 && (
        <>
          <div className="section-title">Tracked</div>
          <div className="card">
            {rest.map((w) => (
              <WhaleRow key={w.address} w={w} following={following.includes(w.address)} onToggle={toggle} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
