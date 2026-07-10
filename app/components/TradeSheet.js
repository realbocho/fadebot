"use client";

// Bottom sheet that takes a user from zero to a filled order:
// wallet (create/import + PIN) → fund → one-time approvals → market buy.
// All signing happens on-device; the key is stored PIN-encrypted.

import { useEffect, useState } from "react";
import {
  hasWallet, createWallet, importWallet, unlockWallet, deleteWallet,
  getBalances, missingApprovals, grantApprovals,
} from "@/lib/wallet";
const PM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
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
  const [setupMode, setSetupMode] = useState(null); // null | 'connect' | 'fresh'
  const [showImport, setShowImport] = useState(false);
  const [pmAddress, setPmAddress] = useState("");
  const [pmAccountType, setPmAccountType] = useState(1); // 1 email/Google · 2 crypto wallet
  const [acct, setAcct] = useState({ sigType: 0, funder: null });
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

  const afterUnlock = async ({ wallet: w, funder, sigType }) => {
    setStatus("Connecting to the order book…");
    setWallet(w);
    setAcct({ sigType, funder });
    const c = await createTradingClient(w, { sigType, funder });
    setClient(c);
    if (sigType === 0) {
      const [bal, clob, missing] = await Promise.all([
        getBalances(w.address),
        getClobBalance(c),
        missingApprovals(w.address),
      ]);
      setBalances(bal);
      setClobBalance(clob);
      setNeedsApproval(missing.length > 0);
    } else {
      // Polymarket account: funds live in the Polymarket proxy — no POL,
      // no approvals, balance comes straight from the CLOB.
      setBalances(null);
      setClobBalance(await getClobBalance(c));
      setNeedsApproval(false);
    }
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

  const doConnectPolymarket = async () => {
    if (pin.length < 4) return setError("PIN needs at least 4 digits.");
    if (!importKey.trim()) return setError("Paste the private key exported from Polymarket.");
    if (!PM_ADDR_RE.test(pmAddress.trim()))
      return setError("Paste your Polymarket address (0x…, shown on your profile).");
    setError(""); setStep("working"); setStatus("Connecting your Polymarket account…");
    try {
      await importWallet(pin, importKey, {
        funder: pmAddress.trim().toLowerCase(),
        sigType: pmAccountType,
      });
      // Best effort: link the address so the Portfolio tab works immediately.
      try {
        await fetch("/api/user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tg-init-data": window.Telegram?.WebApp?.initData || "",
          },
          body: JSON.stringify({ pm_address: pmAddress.trim() }),
        });
      } catch { /* non-blocking */ }
      await afterUnlock(await unlockWallet(pin));
    } catch (e) { fail(e); }
  };

  const doReset = async () => {
    const really = window.confirm(
      "Remove this wallet from the device?\n\nIf it holds funds and you haven't backed up the private key, they will be UNRECOVERABLE. Polymarket-connected accounts are safe — your funds stay on Polymarket and you can reconnect anytime."
    );
    if (!really) return;
    await deleteWallet();
    setPin(""); setImportKey(""); setPmAddress("");
    setWallet(null); setClient(null); setBalances(null); setClobBalance(null);
    setAcct({ sigType: 0, funder: null });
    setSetupMode(null); setError("");
    setStep("setup");
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
      // CLOB returns 200 even for rejected/killed orders — inspect the body.
      if (!r || r.success === false || r.errorMsg) {
        const msg = String(r?.errorMsg || "Order rejected by the exchange.");
        throw new Error(
          /balance|allowance|collateral|insufficient/i.test(msg)
            ? "Not enough tradable balance for this order. Fund your wallet (USDC on Polygon), run the one-time approvals, then hit ↻ and try again."
            : msg
        );
      }
      const st = String(r.status || "").toLowerCase();
      if (st && !["matched", "mined", "confirmed", "success", "live"].includes(st)) {
        throw new Error(
          st === "unmatched" || st === "killed" || st === "cancelled"
            ? "Fill-or-kill: not enough liquidity at this price right now, so the order was cancelled. Nothing was spent — try a smaller amount."
            : `Order not filled (status: ${r.status}). Nothing was spent.`
        );
      }
      setResult(r);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
      setStep("done");
    } catch (e) { fail(e); }
  };

  const refresh = async () => {
    if (!wallet || !client) return;
    if (acct.sigType === 0) setBalances(await getBalances(wallet.address));
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

        {step === "setup" && !setupMode && (
          <>
            <p className="sheet-note">
              Already on Polymarket? Connect your account and trade straight from your
              existing balance — no deposits, no gas. Or create a fresh wallet.
            </p>
            <div className="btn-pair" style={{ flexDirection: "column" }}>
              <button className="btn primary" onClick={() => setSetupMode("connect")}>
                Connect Polymarket account (recommended)
              </button>
              <button className="btn ghost" onClick={() => setSetupMode("fresh")}>
                Create a fresh wallet instead
              </button>
            </div>
          </>
        )}

        {step === "setup" && setupMode === "connect" && (
          <>
            <p className="sheet-note">
              In Polymarket: Settings → <b>Export Private Key</b>. Paste it below with
              your Polymarket address (top of your profile page). The key is encrypted
              with your PIN and stored only on this device — FadeBot's servers never
              see it. Anyone with this key controls your funds; never share it in chat.
            </p>
            <div className="field">
              <input type="password" placeholder="Private key from Polymarket (0x…)"
                value={importKey} onChange={(e) => setImportKey(e.target.value)}
                aria-label="Polymarket private key" />
            </div>
            <div className="field">
              <input placeholder="Your Polymarket address (0x…)" value={pmAddress}
                onChange={(e) => setPmAddress(e.target.value)} aria-label="Polymarket address" />
            </div>
            <div className="preset-row" role="radiogroup" aria-label="Login method">
              <button className={`btn small ${pmAccountType === 1 ? "primary" : "ghost"}`}
                onClick={() => setPmAccountType(1)}>I log in with email/Google</button>
              <button className={`btn small ${pmAccountType === 2 ? "primary" : "ghost"}`}
                onClick={() => setPmAccountType(2)}>I log in with a crypto wallet</button>
            </div>
            <div className="field">
              <input type="password" inputMode="numeric" placeholder="Choose a PIN (4+ digits)"
                value={pin} onChange={(e) => setPin(e.target.value)} aria-label="PIN" />
            </div>
            {error && <div className="err">{error}</div>}
            <div className="btn-pair">
              <button className="btn primary" onClick={doConnectPolymarket}>Connect</button>
              <button className="btn ghost" onClick={() => { setError(""); setSetupMode(null); }}>Back</button>
            </div>
          </>
        )}

        {step === "setup" && setupMode === "fresh" && (
          <>
            <p className="sheet-note">
              Trades are signed by a wallet that lives only on this device, locked with a
              PIN. FadeBot's servers never see your key. Losing the PIN means losing
              access — back up the key after creating it. You'll need to fund it with
              USDC + a little POL (Polygon).
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
            <button className="view-link" onClick={() => { setError(""); setSetupMode(null); }}>← Back</button>
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
            <button className="view-link" onClick={doReset}>
              Forgot PIN or switching accounts? Remove wallet from this device
            </button>
          </>
        )}

        {step === "working" && <div className="loading">{status || "Working…"}</div>}

        {step === "ready" && (
          <>
            <div className="wallet-strip mono">
              <span>
                {acct.sigType !== 0 ? "PM " : ""}
                {(acct.funder || wallet.address).slice(0, 6)}…{(acct.funder || wallet.address).slice(-4)}
              </span>
              <span>
                {clobBalance != null ? `${fmt(clobBalance)} tradable` : balances ? `${fmt(balances.collateral)} USDC` : "…"}
                {acct.sigType === 0 && balances ? ` · ${balances.pol.toFixed(3)} POL` : ""}
              </span>
              <button className="btn small ghost" onClick={refresh}>↻</button>
            </div>

            {acct.sigType !== 0 && (clobBalance ?? 0) <= 0 && (
              <p className="sheet-note">
                Your Polymarket balance reads $0. Top up on polymarket.com, then hit ↻.
                If you know the balance isn't zero, check the address and login-method
                you connected with.
              </p>
            )}

            {acct.sigType === 0 && (clobBalance ?? balances?.collateral ?? 0) <= 0 && (
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

            <button className="view-link" style={{ margin: "0 0 10px", textAlign: "left" }} onClick={doReset}>
              Switch account / remove wallet from device
            </button>

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
            {(() => {
              const funds = clobBalance ?? balances?.collateral ?? 0;
              const blocked =
                !builderCodeConfigured() ? "Builder code not configured" :
                needsApproval ? "Enable trading first (approvals above)" :
                funds < usd ? `Fund wallet first — ${fmt(funds)} tradable of ${fmt(usd)} needed` :
                null;
              return (
                <button className={`btn ${modeClass}`} style={{ width: "100%" }}
                  disabled={!confirmed || usd < 1 || Boolean(blocked)} onClick={doBuy}>
                  {blocked || `${modeLabel} — Buy ${target.outcome} for ${fmt(usd)}`}
                </button>
              );
            })()}
          </>
        )}

        {step === "done" && (
          <>
            <div className="gauge-gapnum">✓<small>ORDER SUBMITTED</small></div>
            <p className="sheet-note">
              {result?.orderID ? `Order ${String(result.orderID).slice(0, 10)}… — ` : ""}
              status: {result?.status || "submitted"}
              {result?.takingAmount ? ` · filled ${Number(result.takingAmount).toLocaleString()} shares` : ""}.
              Check Portfolio for your position.
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
