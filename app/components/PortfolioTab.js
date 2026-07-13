"use client";

import { useEffect, useState } from "react";
import { useApi } from "../page";

const fmtUsd = (n) => "$" + Math.abs(Math.round(n)).toLocaleString("en-US");

export default function PortfolioTab() {
  const api = useApi();
  const [state, setState] = useState({ loading: true });
  const [addr, setAddr] = useState("");
  const [error, setError] = useState("");

  const load = () =>
    api("/api/portfolio")
      .then((r) => setState({ loading: false, ...r }))
      .catch((e) => setState({ loading: false, error: e.message }));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const link = async () => {
    setError("");
    try {
      await api("/api/user", { method: "POST", body: JSON.stringify({ pm_address: addr }) });
      setState({ loading: true });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (state.loading) return <div className="loading">Loading your positions…</div>;
  if (state.error) return <div className="err">{state.error}</div>;

  if (!state.linked) {
    return (
      <div className="card">
        <div className="eyebrow">🔱 Link your wallet</div>
        <h3>Track your bounty here</h3>
        <p className="empty" style={{ textAlign: "left", padding: "10px 0" }}>
          Paste your Polymarket wallet address (read-only — HARPOON never asks for keys
          or custody of funds). Find it on your Polymarket profile page.
        </p>
        <div className="field">
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" aria-label="Wallet address" />
          <button className="btn primary" onClick={link}>Link</button>
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    );
  }

  const total = state.positions.reduce((s, p) => s + p.value, 0);
  const pnl = state.positions.reduce((s, p) => s + p.pnl, 0);

  return (
    <div>
      <div className="card">
        <div className="eyebrow">🔱 Bounty · {state.address.slice(0, 6)}…{state.address.slice(-4)}</div>
        <div className="gauge-gapnum" style={{ textAlign: "left" }}>
          {fmtUsd(total)}
          <small>OPEN VALUE · P&L <span className={pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{pnl >= 0 ? "+" : "−"}{fmtUsd(pnl)}</span></small>
        </div>
      </div>

      {state.positions.length === 0 && <p className="empty">No active hunts on this wallet yet.</p>}

      {state.positions.map((p, i) => (
        <div className="card" key={i}>
          <h3 style={{ fontSize: 13.5 }}>{p.title}</h3>
          <div className="row" style={{ borderTop: 0, paddingBottom: 0 }}>
            <div className="who">
              <span>
                {p.outcome} · entry {Number.isFinite(p.avgPrice) ? p.avgPrice.toFixed(2) : "–"} → now{" "}
                {Number.isFinite(p.curPrice) ? p.curPrice.toFixed(2) : "–"}
              </span>
            </div>
            <div className="nums">
              <b>{fmtUsd(p.value)}</b>
              <span className={p.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>
                {p.pnl >= 0 ? "+" : "−"}{fmtUsd(p.pnl)}
              </span>
            </div>
          </div>
        </div>
      ))}

      <button
        className="btn ghost"
        style={{ width: "100%" }}
        onClick={async () => {
          await api("/api/user", { method: "POST", body: JSON.stringify({ pm_address: null }) });
          setState({ loading: false, linked: false, positions: [] });
        }}
      >
        Unlink wallet
      </button>
    </div>
  );
}
