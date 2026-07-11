"use client";

// Bottom sheet that takes a user from zero to a filled order:
// wallet (create/import + PIN) → fund → one-time approvals → market buy.
// All signing happens on-device; the key is stored PIN-encrypted.

import { useEffect, useRef, useState } from "react";
import {
  hasWallet, createWallet, importWallet, unlockWallet, deleteWallet, updateWalletMeta,
  getBalances, missingApprovals, grantApprovals,
} from "@/lib/wallet";
import { ensureDepositAccount, deriveDepositAddress, getFundingBreakdown, wrapToTradable, withdrawFromDepositWallet, redeemWinnings } from "@/lib/deposit";
import { fetchUserPositions } from "@/lib/polymarket";
const PM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
import {
  createTradingClient, getClobBalance, getClobBalanceRaw, syncClobBalance, placeMarketBuy, placeMarketSell, builderCodeConfigured,
} from "@/lib/clob";

const PRESETS = [10, 25, 50, 100];
const fmt = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

// Dispatcher: with Privy configured, users get zero-click Telegram login and a
// gasless deposit-wallet account — no PIN, no keys. Without it, the PIN-wallet
// flow below still works, so Privy setup is optional.
export default function TradeSheet(props) {
  return PRIVY_ENABLED ? <PrivySheet {...props} /> : <SheetCore {...props} privy={null} />;
}

function PrivySheet(props) {
  // Hooks live in a separate component so they only run inside PrivyProvider.
  const { usePrivy, useWallets } = require("@privy-io/react-auth");
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const getSigner = async () => {
    const embedded =
      wallets.find((w) => w.walletClientType === "privy") || wallets[0];
    if (!embedded) throw new Error("No wallet available yet — try again in a second.");
    const eip1193 = await embedded.getEthereumProvider();
    const { providers } = await import("ethers");
    return new providers.Web3Provider(eip1193).getSigner();
  };

  return (
    <SheetCore
      {...props}
      privy={{ ready, authenticated, login, logout, getSigner, walletCount: wallets.length }}
    />
  );
}

function SheetCore({ target, onClose, privy }) {
  // target: { market, outcome, tokenID, refPrice, mode: 'copy'|'fade' }
  const [step, setStep] = useState("boot"); // boot|setup|unlock|ready|working|done|error
  const pinRef = useRef(null);
  const keyRef = useRef(null);
  const addrRef = useRef(null);
  const readField = (ref, label) => {
    const fromRef = ref.current?.value;
    if (fromRef && fromRef.trim()) return fromRef.trim();
    // Fallback: read the mounted input directly. Telegram webviews and some
    // Android keyboards can leave a stale/detached ref while the visible DOM
    // node holds the real value.
    const els = document.querySelectorAll(`.sheet input[aria-label="${label}"]`);
    for (const el of els) if (el.value && el.value.trim()) return el.value.trim();
    return "";
  };
  const readPin = () => readField(pinRef, "PIN");
  const readKey = () => readField(keyRef, "Polymarket private key") || readField(keyRef, "Private key");
  const readAddr = () => readField(addrRef, "Polymarket address");
  const [setupMode, setSetupMode] = useState(null); // null | 'connect' | 'fresh'
  const [showImport, setShowImport] = useState(false);
  const [pmAccountType, setPmAccountType] = useState(3); // 3 modern deposit-wallet · 1 legacy proxy · 2 Safe
  const [acct, setAcct] = useState({ sigType: 0, funder: null });
  const [wallet, setWallet] = useState(null);
  const [client, setClient] = useState(null);
  const [balances, setBalances] = useState(null);
  const [clobBalance, setClobBalance] = useState(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [funding, setFunding] = useState(null); // {pusd, usdc, usdce, wrappable}
  const [usd, setUsd] = useState(25);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [myShares, setMyShares] = useState(0); // shares held of THIS market's token
  const [claimable, setClaimable] = useState(null); // { items: [{conditionId, negRisk}], total }
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [wdAmt, setWdAmt] = useState("");
  const wdAddrRef = useRef(null);

  // Load the user's position in this market — and any resolved, unclaimed
  // winnings across all markets — whenever the account is ready.
  useEffect(() => {
    const addr = acct.funder || wallet?.address;
    if (step !== "ready" || !addr) return;
    (async () => {
      try {
        const positions = await fetchUserPositions(addr);
        const mine = (positions || []).find(
          (p) => String(p.asset ?? p.tokenId ?? p.token_id) === String(target.tokenID)
        );
        setMyShares(Number(mine?.size ?? 0));

        // First-time users land with $0 — open the deposit guide for them.
        setShowDeposit((v) => v || (Number(clobBalance ?? 0) <= 0));

        // Redeemable = market resolved, tokens not yet burned for pUSD.
        const seen = new Set();
        const items = []; let total = 0;
        for (const p of positions || []) {
          if (!p?.redeemable || !p.conditionId) continue;
          total += Number(p.size ?? 0) * Number(p.curPrice ?? 0);
          if (seen.has(p.conditionId)) continue;
          seen.add(p.conditionId);
          items.push({ conditionId: p.conditionId, negRisk: Boolean(p.negativeRisk ?? p.negRisk) });
        }
        setClaimable(items.length ? { items, total } : null);
      } catch { setMyShares(0); setClaimable(null); }
    })();
  }, [step, acct.funder, wallet?.address, target.tokenID]);

  useEffect(() => {
    (async () => {
      // A locally connected Polymarket account (key import) always wins —
      // the user explicitly chose to trade that balance.
      if (await hasWallet()) { setStep("unlock"); return; }
      if (privy) {
        if (!privy.ready) return; // wait for Privy init
        if (!privy.authenticated) setStep("privy-login");
        else startPrivySession();
        return;
      }
      setStep("setup");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privy?.ready, privy?.authenticated, privy?.walletCount]);

  const startPrivySession = async () => {
    setStep("working");
    try {
      setStatus("Setting up your account…");
      const signer = await privy.getSigner();
      const { depositWallet } = await ensureDepositAccount(signer, setStatus);
      const c = await createTradingClient(signer, { sigType: 3, funder: depositWallet });
      setWallet({ address: depositWallet }); // display only
      setAcct({ sigType: 3, funder: depositWallet.toLowerCase() });
      setClient(c);
      setBalances(null);
      setClobBalance(await syncClobBalance(c));
      setNeedsApproval(false);
      // Link for Portfolio tab (best effort)
      try {
        await fetch("/api/user", {
          method: "POST",
          headers: { "Content-Type": "application/json",
            "x-tg-init-data": window.Telegram?.WebApp?.initData || "" },
          body: JSON.stringify({ pm_address: depositWallet }),
        });
      } catch { /* non-blocking */ }
      setStep("ready");
      setStatus("");
    } catch (e) { fail(e); }
  };

  const fail = (e) => {
    const raw = e?.data?.error || e?.message || String(e);
    const msg = /wallet busy|active action/i.test(raw)
      ? "The relayer is still finishing your previous transaction. Wait 1–2 minutes, then tap the button again — no funds were moved."
      : raw;
    setError(msg); setStep("error");
  };

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
    } else if (sigType === 3) {
      // Official deposit-wallet account: fully gasless, approvals were set
      // via the relayer at creation. Sync the CLOB balance cache and read it.
      setBalances(null);
      setClobBalance(await syncClobBalance(c));
      setNeedsApproval(false);
    } else {
      // Connected Polymarket account (proxy/Safe): funds live on Polymarket —
      // no POL, no approvals. The CLOB balance cache must be synced first or a
      // real balance can read as $0.
      setBalances(null);
      setClobBalance(await syncClobBalance(c));
      setNeedsApproval(false);
    }
    setStep("ready");
    setStatus("");
  };

  const doCreate = async () => {
    const pin = readPin(), importKey = readKey();
    if (pin.length < 4) return setError("PIN needs at least 4 digits.");
    setError(""); setStep("working"); setStatus("Creating your trading wallet…");
    try {
      showImport && importKey
        ? await importWallet(pin, importKey)
        : await createWallet(pin);
      await afterUnlock(await unlockWallet(pin));
    } catch (e) { fail(e); }
  };

  const doCreateAccount = async () => {
    const pin = readPin();
    if (pin.length < 4)
      return setError(`PIN needs at least 4 digits (read ${pin.length} character${pin.length === 1 ? "" : "s"} — if you typed more, tap the PIN box once and press the button again).`);
    setError(""); setStep("working"); setStatus("Creating your trading account…");
    try {
      if (!(await hasWallet())) await createWallet(pin);
      const { wallet: w } = await unlockWallet(pin);
      const { depositWallet } = await ensureDepositAccount(w, setStatus);
      await updateWalletMeta({ funder: depositWallet.toLowerCase(), sigType: 3 });
      // Link for the Portfolio tab (best effort)
      try {
        await fetch("/api/user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tg-init-data": window.Telegram?.WebApp?.initData || "",
          },
          body: JSON.stringify({ pm_address: depositWallet }),
        });
      } catch { /* non-blocking */ }
      await afterUnlock(await unlockWallet(pin));
    } catch (e) { fail(e); }
  };

  const doConnectPolymarket = async () => {
    const pin = readPin(), importKey = readKey(), pmAddress = readAddr();
    if (!importKey) return setError("Paste the private key exported from Polymarket.");
    if (pin.length < 4) return setError("PIN needs at least 4 digits.");
    // sigType 3 (modern email/Google accounts) derives the deposit wallet from
    // the owner key — no address to paste. Types 1/2 need the profile address.
    if (pmAccountType !== 3 && !PM_ADDR_RE.test(pmAddress))
      return setError("Paste your Polymarket address (0x…, shown on your profile).");
    setError(""); setStep("working"); setStatus("Connecting your Polymarket account…");
    try {
      let funder = pmAddress.toLowerCase();
      if (pmAccountType === 3) {
        setStatus("Finding your trading wallet…");
        const { wallet: probe } = await (async () => {
          await importWallet(pin, importKey, { funder: "0x", sigType: 3 });
          return unlockWallet(pin);
        })();
        funder = (await deriveDepositAddress(probe)).toLowerCase();
      }
      await importWallet(pin, importKey, {
        funder,
        sigType: pmAccountType,
      });
      const pmAddressForLink = funder;
      // Best effort: link the address so the Portfolio tab works immediately.
      try {
        await fetch("/api/user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tg-init-data": window.Telegram?.WebApp?.initData || "",
          },
          body: JSON.stringify({ pm_address: pmAddressForLink }),
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
    if (pinRef.current) pinRef.current.value = "";
    if (keyRef.current) keyRef.current.value = "";
    if (addrRef.current) addrRef.current.value = "";
    setWallet(null); setClient(null); setBalances(null); setClobBalance(null);
    setAcct({ sigType: 0, funder: null });
    setSetupMode(null); setError("");
    setStep("setup");
  };

  const doUnlock = async () => {
    const pin = readPin();
    if (!pin) return setError("Enter your PIN.");
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
    const bal = await syncClobBalance(client);
    setClobBalance(bal);
    if (acct.sigType === 3 && (bal ?? 0) <= 0) {
      // Most common cause: raw USDC sent directly to the address — it must be
      // wrapped into pUSD before the CLOB counts it. Detect and offer one tap.
      let fb;
      try { fb = await getFundingBreakdown(acct.funder); }
      catch (e) { setError(e.message); return; }
      setFunding(fb);
      if (fb.usdce <= 0 && fb.usdc <= 0 && fb.pusd <= 0) {
        const raw = await getClobBalanceRaw(client);
        setError("Balance still $0 — nothing detected at " + acct.funder.slice(0, 10) +
          "…. CLOB response: " + JSON.stringify(raw));
      } else { setError(""); }
    } else if (acct.sigType !== 0 && (bal ?? 0) <= 0) {
      const raw = await getClobBalanceRaw(client);
      setError("CLOB balance still $0. Debug — funder " +
        (acct.funder || "?").slice(0, 10) + "…, sigType " + acct.sigType +
        ", response: " + JSON.stringify(raw));
    }
  };

  const doWrap = async () => {
    setStep("working");
    try {
      // PIN sessions keep the unlocked signer in `wallet`; Privy sessions
      // store a display object there, so fetch the real signer from Privy.
      const signer = privy?.authenticated ? await privy.getSigner() : wallet;
      await wrapToTradable(signer, acct.funder, setStatus);
      setClobBalance(await syncClobBalance(client));
      setFunding(await getFundingBreakdown(acct.funder));
    } catch (e) { fail(e); }
  };

  // Sell the full position in this market's outcome token (FOK market sell).
  const doSell = async () => {
    setStep("working"); setStatus("Selling position…");
    try {
      const r = await placeMarketSell(client, { tokenID: target.tokenID, shares: myShares });
      if (!r || r.success === false || r.errorMsg)
        throw new Error(String(r?.errorMsg || "Sell rejected by the exchange."));
      const st = String(r.status || "").toLowerCase();
      if (st && !["matched", "mined", "confirmed", "success", "live"].includes(st))
        throw new Error(
          st === "unmatched" || st === "killed" || st === "cancelled"
            ? "Fill-or-kill: not enough buyers at this price right now, so the sell was cancelled. Your shares are untouched — try again later."
            : `Sell not filled (status: ${r.status}). Your shares are untouched.`
        );
      setResult({ ...r, action: "sell" });
      setClobBalance(await syncClobBalance(client));
      setMyShares(0);
      setStep("done"); setStatus("");
    } catch (e) { fail(e); }
  };

  // Withdraw pUSD → USDC.e to an external Polygon address (deposit wallets only).
  const doWithdraw = async () => {
    const to = (wdAddrRef.current?.value || "").trim();
    const amt = wdAmt === "" ? null : Number(wdAmt);
    if (!PM_ADDR_RE.test(to)) return setError("Paste a valid Polygon address (0x…).");
    if (amt != null && (!Number.isFinite(amt) || amt <= 0)) return setError("Enter a valid amount, or leave blank to withdraw everything.");
    setError(""); setStep("working");
    try {
      const signer = privy?.authenticated ? await privy.getSigner() : wallet;
      const r = await withdrawFromDepositWallet(signer, acct.funder, to, amt, setStatus);
      setResult({ action: "withdraw", ...r });
      setClobBalance(await syncClobBalance(client));
      setShowWithdraw(false); setWdAmt("");
      setStep("done"); setStatus("");
    } catch (e) { fail(e); }
  };

  // Redeem all resolved winning positions into the tradable balance.
  const doClaim = async () => {
    setStep("working");
    try {
      const signer = privy?.authenticated ? await privy.getSigner() : wallet;
      const r = await redeemWinnings(signer, acct.funder, claimable.items, setStatus);
      setResult({ action: "claim", ...r, total: claimable.total });
      setClaimable(null);
      setClobBalance(await syncClobBalance(client));
      setStep("done"); setStatus("");
    } catch (e) { fail(e); }
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

        {step === "privy-login" && (
          <>
            <p className="sheet-note">
              One tap to start trading — your account is created from your Telegram
              identity. No seed phrases, no keys, no gas.
            </p>
            <button className="btn primary" style={{ width: "100%" }}
              onClick={() => privy.login()}>
              Continue with Telegram
            </button>

          </>
        )}

        {step === "setup" && !setupMode && (
          <>
            <p className="sheet-note">
              Set up a trading account in one tap — no gas, no seed phrases, no key
              pasting. You just pick a PIN. (Powered by Polymarket's official
              deposit-wallet flow.)
            </p>
            <div className="field">
              <input ref={pinRef} type="password" inputMode="numeric"
                placeholder="Choose a PIN (4+ digits)" autoComplete="off"
                onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250)}
                aria-label="PIN" />
            </div>
            {error && <div className="err">{error}</div>}
            <button className="btn primary" style={{ width: "100%" }} onClick={doCreateAccount}>
              Create trading account
            </button>

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
              <input ref={keyRef} type="password" placeholder="Private key from Polymarket (0x…)"
                autoComplete="off" onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250)}
                aria-label="Polymarket private key" />
            </div>
            {pmAccountType !== 3 && (
              <div className="field">
                <input ref={addrRef} placeholder="Your Polymarket address (0x…)"
                  autoComplete="off" onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250)} aria-label="Polymarket address" />
              </div>
            )}
            <div className="eyebrow" style={{ marginTop: 4 }}>How do you sign in to Polymarket?</div>
            <div className="preset-row" role="radiogroup" aria-label="Login method" style={{ flexWrap: "wrap" }}>
              <button className={`btn small ${pmAccountType === 3 ? "primary" : "ghost"}`}
                onClick={() => setPmAccountType(3)}>Email/Google (2026+)</button>
              <button className={`btn small ${pmAccountType === 1 ? "primary" : "ghost"}`}
                onClick={() => setPmAccountType(1)}>Email/Google (older)</button>
              <button className={`btn small ${pmAccountType === 2 ? "primary" : "ghost"}`}
                onClick={() => setPmAccountType(2)}>Crypto wallet</button>
            </div>
            <p className="sheet-note" style={{ marginTop: 8 }}>
              Most current email/Google accounts are "2026+". If your balance reads $0
              after connecting, hit ↻ then try the other email option.
            </p>
            <div className="field">
              <input ref={pinRef} type="password" inputMode="numeric" placeholder="Choose a PIN (4+ digits)"
                autoComplete="off" onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250)} aria-label="PIN" />
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
              <input ref={pinRef} type="password" inputMode="numeric" placeholder="Choose a PIN (4+ digits)"
                autoComplete="off" onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250)} aria-label="PIN" />
            </div>
            {showImport && (
              <div className="field">
                <input ref={keyRef} type="password" placeholder="Private key (0x…)"
                  autoComplete="off" onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250)} aria-label="Private key" />
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
              <input ref={pinRef} type="password" inputMode="numeric" placeholder="Enter your PIN"
                autoComplete="off" onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250)}
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
              <span style={{ cursor: "pointer" }} title="Tap to copy"
                onClick={() => { navigator.clipboard?.writeText(acct.funder || wallet.address);
                  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success"); }}>
                {acct.sigType !== 0 ? "PM " : ""}
                {(acct.funder || wallet.address).slice(0, 6)}…{(acct.funder || wallet.address).slice(-4)} ⧉
              </span>
              <span>
                {clobBalance != null ? `${fmt(clobBalance)} tradable` : balances ? `${fmt(balances.collateral)} USDC` : "…"}
                {acct.sigType === 0 && balances ? ` · ${balances.pol.toFixed(3)} POL` : ""}
              </span>
              <button className="btn small ghost" onClick={refresh}>↻</button>
            </div>

            {acct.sigType === 3 && (
              <>
                <button className="view-link" style={{ margin: "0 0 8px", textAlign: "left" }}
                  onClick={() => setShowDeposit((v) => !v)}>
                  {showDeposit ? "▾ Deposit funds" : "▸ Deposit funds"}
                </button>
                {showDeposit && (
                  <div style={{ marginBottom: 12 }}>
                    <p className="sheet-note">
                      1. Send <b>USDC on the Polygon network</b> (USDC.e or native — both work)
                      to your trading address below.<br />
                      2. Wait ~1 min, then tap ↻ above.<br />
                      3. Tap the <b>Convert</b> button that appears — done, ready to bet.<br />
                      ⚠️ Polygon network only. Other chains can lose your funds.
                    </p>
                    <button className="btn ghost mono" style={{ width: "100%", wordBreak: "break-all", whiteSpace: "normal" }}
                      onClick={() => { navigator.clipboard?.writeText(acct.funder);
                        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success"); }}>
                      {acct.funder} ⧉ tap to copy
                    </button>
                  </div>
                )}
              </>
            )}

            {acct.sigType === 3 && claimable && (
              <div className="quote mono" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ flex: 1 }}>
                  🏆 {fmt(claimable.total)} in resolved winnings across {claimable.items.length} market{claimable.items.length > 1 ? "s" : ""}.
                </span>
                <button className="btn small primary" onClick={doClaim}>Claim</button>
              </div>
            )}

            {myShares > 0 && (
              <div className="quote mono" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ flex: 1 }}>
                  You hold {myShares.toLocaleString()} {target.outcome} shares in this market.
                </span>
                <button className="btn small danger" onClick={doSell}>Sell all</button>
              </div>
            )}

            {acct.sigType === 3 && (clobBalance ?? 0) > 0 && (
              <>
                <button className="view-link" style={{ margin: "0 0 8px", textAlign: "left" }}
                  onClick={() => setShowWithdraw((v) => !v)}>
                  {showWithdraw ? "▾ Withdraw funds" : "▸ Withdraw funds"}
                </button>
                {showWithdraw && (
                  <div style={{ marginBottom: 12 }}>
                    <p className="sheet-note">
                      Sends <b>USDC.e on Polygon</b> to the address below — make sure it's a
                      Polygon address you control (exchange deposit addresses must support
                      USDC.e on Polygon). Gas-free.
                    </p>
                    <input className="preset-custom mono" style={{ width: "100%", marginBottom: 6 }}
                      ref={wdAddrRef} placeholder="Destination address (0x…)" aria-label="Withdrawal address" />
                    <div style={{ display: "flex", gap: 8 }}>
                      <input className="preset-custom mono" style={{ flex: 1 }} type="number" min="1"
                        value={wdAmt} onChange={(e) => setWdAmt(e.target.value)}
                        placeholder={`Amount (blank = all ${fmt(clobBalance ?? 0)})`} aria-label="Withdrawal amount" />
                      <button className="btn ghost" onClick={doWithdraw}>Withdraw</button>
                    </div>
                  </div>
                )}
              </>
            )}

            {acct.sigType === 3 && (clobBalance ?? 0) <= 0 && (
              <>
                {funding && funding.wrappable > 0 ? (
                  <>
                    <p className="sheet-note">
                      Found <b style={{ color: "var(--smart)" }}>${funding.wrappable.toFixed(2)} USDC</b> at
                      your trading address
                      {funding.usdc > 0 && funding.usdce > 0
                        ? ` ($${funding.usdce.toFixed(2)} USDC.e + $${funding.usdc.toFixed(2)} native)`
                        : funding.usdc > 0 ? " (native)" : " (USDC.e)"}.
                      Polymarket trades in pUSD — one tap converts it, gas-free.
                      {funding.usdc > 0 && " Native USDC is auto-swapped to USDC.e first (~0.01% pool fee)."}
                    </p>
                    <button className="btn primary" style={{ width: "100%", marginBottom: 10 }} onClick={doWrap}>
                      Convert ${funding.wrappable.toFixed(2)} to trading balance
                    </button>
                  </>
                ) : (
                  <p className="sheet-note">
                    Fund your trading account: send USDC (Polygon) to your trading
                    address — tap to copy:{" "}
                    <button className="btn small ghost mono"
                      onClick={() => { navigator.clipboard?.writeText(acct.funder);
                        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success"); }}>
                      {acct.funder?.slice(0, 10)}… copy
                    </button>
                    {" "}Then hit ↻ — the app will detect it and convert it for you.
                  </p>
                )}
              </>
            )}

            {acct.sigType === 1 || acct.sigType === 2 ? (clobBalance ?? 0) <= 0 && (
              <p className="sheet-note">
                Your Polymarket balance reads $0. Top up on polymarket.com, then hit ↻.
                If you know the balance isn't zero, check the address and login-method
                you connected with.
              </p>
            ) : null}

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

            <button className="view-link" style={{ margin: "0 0 10px", textAlign: "left" }}
              onClick={privy ? () => { privy.logout(); setStep("privy-login"); } : doReset}>
              {privy ? "Log out" : "Switch account / remove wallet from device"}
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
            <div className="gauge-gapnum">✓<small>
              {result?.action === "withdraw" ? "WITHDRAWAL SENT" : result?.action === "sell" ? "POSITION SOLD" : result?.action === "claim" ? "WINNINGS CLAIMED" : "ORDER SUBMITTED"}
            </small></div>
            <p className="sheet-note">
              {result?.action === "claim" ? (
                <>Redeemed {result.redeemed} market{result.redeemed > 1 ? "s" : ""} — ~{fmt(result.total)} added to your tradable balance. Hit ↻ if it hasn't updated yet.</>
              ) : result?.action === "withdraw" ? (
                <>Sent ${Number(result.withdrawn).toFixed(2)} as USDC.e to {String(result.to).slice(0, 8)}…{String(result.to).slice(-4)} on Polygon. It should arrive within a minute.</>
              ) : (
                <>
                  {result?.orderID ? `Order ${String(result.orderID).slice(0, 10)}… — ` : ""}
                  status: {result?.status || "submitted"}
                  {result?.takingAmount ? ` · ${result?.action === "sell" ? "received" : "filled"} ${Number(result.takingAmount).toLocaleString()} ${result?.action === "sell" ? "" : "shares"}` : ""}.
                  {result?.action === "sell" ? " Proceeds are in your tradable balance." : " Check Portfolio for your position."}
                </>
              )}
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
