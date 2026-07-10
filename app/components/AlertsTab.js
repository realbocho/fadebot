"use client";

import { useEffect, useState } from "react";
import { useApi } from "../page";

export default function AlertsTab() {
  const api = useApi();
  const [whales, setWhales] = useState([]);
  const [following, setFollowing] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/whales")
      .then((r) => { setWhales(r.whales || []); setFollowing(r.following || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [api]);

  const followed = whales.filter((w) => following.includes(w.address));

  const unfollow = async (address) => {
    await api("/api/follow", { method: "POST", body: JSON.stringify({ address }) });
    setFollowing((f) => f.filter((a) => a !== address));
  };

  if (loading) return <div className="loading">Loading your alerts…</div>;

  return (
    <div>
      <div className="card">
        <div className="eyebrow">How alerts work</div>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--muted)" }}>
          Follow a whale and FadeBot messages you in this chat the moment they place a
          new buy — with their streak and win rate so you can decide: copy, or fade.
          Every alert shows the whale's entry price next to the current price.
        </p>
      </div>

      <div className="section-title">Following · {followed.length}</div>
      {followed.length === 0 && (
        <p className="empty">
          You're not following anyone yet. Head to the Whales tab and follow a wallet
          to start getting pings.
        </p>
      )}
      {followed.length > 0 && (
        <div className="card">
          {followed.map((w) => (
            <div className="row" key={w.address}>
              <div className="avatar">{w.profile_image ? <img src={w.profile_image} alt="" /> : "🐋"}</div>
              <div className="who">
                <b>{w.name || w.address.slice(0, 10) + "…"}</b>
                <span className={`badge ${w.tier}`} style={{ padding: "2px 6px" }}>{w.tier}</span>
              </div>
              <button className="btn small ghost" onClick={() => unfollow(w.address)}>
                Unfollow
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
