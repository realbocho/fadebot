"use client";

// Bottom sheet that takes a user from zero to a filled order:
// wallet (create/import + PIN) → fund → one-time approvals → market buy.
// All signing happens on-device; the key is stored PIN-encrypted.

import { useEffect, useState } from "react";
import {
  hasWallet, createWallet, importWallet, unlockWallet,
  getBalances, missingApprovals, grantApprovals,
} from "@/lib/wallet";
import {
  createTradingClient, getClobBalance, placeMarketBuy, builderCodeConfigured,
} from "@/lib/clob";

const PRESETS = [10, 25, 50, 100];
const fmt = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

export default function TradeSheet({ target, onClose }) {
  // target: { market, outcome, tokenID, refPrice, mode: 'copy'|'fade' }
  const [step, setStep] = useState("boot"); // boot|setup|unlock|ready|working|done|error
  const [pin, setPin] = useState("");
  const [importKey, setImportKey] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [wallet, setWallet] = useState(null);
  const [client, setClient] = useState(null);
  const [balances, setBalances] = useState(null);
  const [clobBalance, setClobBalance] = useState(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [usd, setUsd] = useState(25);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    hasWallet().then((exists) => setStep(exists ? "unlock" : "setup"));
  }, []);

  const fail = (e) => { setError(e.message || String(e)); setStep("error"); };

  const afterUnlock = async (w) => {
    setStatus("Connecting to the order book…");
    setWallet(w);
    const c = await createTradingClient(w);
    setClient(c);
    const [bal, clob, missing] = await Promise.all([
      getBalances(w.address),
      getClobBalance(c),
      missingApprovals(w.address),
    ]);
    setBalances(bal);
    setClobBalance(clob);
    setNeedsApproval(missing.length > 0);
    setStep("ready");
    setStatus("");
  };

  const doCreate = async () => {
    if (pin.length < 4) return setError("PIN needs at least 4 digits.");
    setError(""); setStep("working"); setStatus("Creating your trading wallet…");
    try {
      showImport && importKey
        ? await importWallet(pin, importKey)
        : await createWallet(pin);
      await afterUnlock(await unlockWallet(pin));
    } catch (e) { fail(e); }
  };

  const doUnlock = async () => {
    setError(""); setStep("working"); setStatus("Unlocking…");
    try { await afterUnlock(await unlockWallet(pin)); } catch (e) { fail(e); }
  };

  const doApprove = async () => {
    setStep("working"); setStatus("Sending one-time approvals…");
    try {
      await grantApprovals(wallet, setStatus);
      setNeedsApproval((await missingApprovals(wallet.address)).length > 0);
      setStep("ready"); setStatus("");
    } catch (e) { fail(e); }
  };

  const doBuy = async () => {
    setStep("working"); setStatus("Placing order…");
    try {
      const r = await placeMarketBuy(client, { tokenID: target.tokenID, usd });
      setResult(r);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
      setStep("done");
    } catch (e) { fail(e); }
  };

  const refresh = async () => {
    if (!wallet || !client) return;
    setBalances(await getBalances(wallet.address));
    setClobBalance(await getClobBalance(client));
  };

  const modeLabel = target.mode === "fade" ? "FADE" : "COPY";
  const modeClass = target.mode === "fade" ? "danger" : "primary";

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Trade">
        <div className="sheet-handle" />
        <div className="eyebrow">
          {modeLabel} · buying <b style={{ color: "var(--text)" }}>{target.outcome}</b>
        </div>
        <h3 style={{ marginBottom: 10 }}>{target.market.question}</h3>

        {!builderCodeConfigured() && (
          <div className="alert-fade">Builder code isn't configured — orders are disabled until <b>NEXT_PUBLIC_BUILDER_CODE</b> is set.</div>
        )}

        {step === "boot" && <div className="loading">Checking device…</div>}

        {step === "setup" && (
          <>
            <p className="sheet-note">
              Trades are signed by a wallet that lives only on this device, locked with a
              PIN. FadeBot's servers never see your key. Losing the PIN means losing
              access — back up the key after creating it.
            </p>
            <div className="field">
              <input type="password" inputMode="numeric" placeholder="Choose a PIN (4+ digits)"
                value={pin} onChange={(e) => setPin(e.target.value)} aria-label="PIN" />
            </div>
            {showImport && (
              <div className="field">
                <input type="password" placeholder="Private key (0x…)" value={importKey}
                  onChange={(e) => setImportKey(e.target.value)} aria-label="Private key" />
              </div>
            )}
            {error && <div className="err">{error}</div>}
            <div className="btn-pair">
              <button className="btn primary" onClick={doCreate}>
                {showImport ? "Import wallet" : "Create wallet"}
              </button>
              <button className="btn ghost" onClick={() => setShowImport(!showImport)}>
                {showImport ? "Create new instead" : "Import existing"}
              </button>
            </div>
          </>
        )}

        {step === "unlock" && (
          <>
            <div className="field">
              <input type="password" inputMode="numeric" placeholder="Enter your PIN"
                value={pin} onChange={(e) => setPin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doUnlock()} aria-label="PIN" />
              <button className="btn primary" onClick={doUnlock}>Unlock</button>
            </div>
            {error && <div className="err">{error}</div>}
          </>
        )}

        {step === "working" && <div className="loading">{status || "Working…"}</div>}

        {step === "ready" && (
          <>
            <div className="wallet-strip mono">
              <span>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
              <span>
                {clobBalance != null ? `${fmt(clobBalance)} tradable` : balances ? `${fmt(balances.collateral)} USDC` : "…"}
                {" · "}{balances ? `${balances.pol.toFixed(3)} POL` : ""}
              </span>
              <button className="btn small ghost" onClick={refresh}>↻</button>
            </div>

            {(clobBalance ?? balances?.collateral ?? 0) <= 0 && (
              <p className="sheet-note">
                Fund this wallet to trade: send USDC (Polygon) for buying power and a
                little POL (~0.1) for one-time approvals. Deposit address is above —
                tap to copy: <button className="btn small ghost mono"
                  onClick={() => { navigator.clipboard?.writeText(wallet.address);
                    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success"); }}>
                  {wallet.address.slice(0, 10)}… copy</button>
              </p>
            )}

            {needsApproval && (
              <button className="btn ghost" style={{ width: "100%", marginBottom: 10 }} onClick={doApprove}>
                Enable trading — one-time approvals (uses a little POL)
              </button>
            )}

            <div className="eyebrow">Amount</div>
            <div className="preset-row">
              {PRESETS.map((p) => (
                <button key={p} className={`btn small ${usd === p ? "primary" : "ghost"}`}
                  onClick={() => setUsd(p)}>{fmt(p)}</button>
              ))}
              <input className="preset-custom mono" type="number" min="1" value={usd}
                onChange={(e) => setUsd(Number(e.target.value))} aria-label="Custom amount" />
            </div>

            <div className="quote mono">
              <span>Ref. price {Number.isFinite(target.refPrice) ? target.refPrice.toFixed(2) : "market"} · fill-or-kill at best available</span>
              <span>Includes Polymarket + FadeBot builder fees</span>
            </div>

            <label className="confirm-line">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I understand this is a real-money bet I can lose. Whales lose too — this is not advice.</span>
            </label>

            {error && <div className="err">{error}</div>}
            <button className={`btn ${modeClass}`} style={{ width: "100%" }}
              disabled={!confirmed || usd < 1 || !builderCodeConfigured()} onClick={doBuy}>
              {modeLabel} — Buy {target.outcome} for {fmt(usd)}
            </button>
          </>
        )}

        {step === "done" && (
          <>
            <div className="gauge-gapnum">✓<small>ORDER SUBMITTED</small></div>
            <p className="sheet-note">
              {result?.orderID ? `Order ${String(result.orderID).slice(0, 10)}… ` : ""}
              Fill-or-kill orders either fill instantly or cancel — check Portfolio for
              your position.
            </p>
            <button className="btn primary" style={{ width: "100%" }} onClick={onClose}>Done</button>
          </>
        )}

        {step === "error" && (
          <>
            <div className="err" style={{ padding: "14px 0" }}>{error}</div>
            <div className="btn-pair">
              <button className="btn ghost" onClick={() => { setError(""); setStep(wallet ? "ready" : "unlock"); }}>Back</button>
              <button className="btn ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
