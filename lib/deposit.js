// Official deposit-wallet flow (Polymarket V2, POLY_1271).
// One tap: derive deterministic deposit wallet → gasless WALLET-CREATE →
// gasless approvals via a relayer WALLET batch. No POL, no user gas, ever.

import { Contract, constants, utils } from "ethers";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { getContractConfig } from "@polymarket/clob-client-v2";
import { polygon } from "viem/chains";
import { getProvider } from "./wallet";

const RPC = process.env.NEXT_PUBLIC_POLYGON_RPC || "https://polygon-rpc.com";
// Route the relayer SDK's internal reads through our RPC instead of viem's
// default public endpoint (which rate-limits hard).
const CHAIN = { ...polygon, rpcUrls: { ...polygon.rpcUrls, default: { http: [RPC] } } };

const RELAYER_URL =
  process.env.NEXT_PUBLIC_RELAYER_URL || "https://relayer-v2.polymarket.com";

const CONFIG = getContractConfig(137);

// USDC → pUSD conversion (CollateralOnramp.wrap, per docs.polymarket.com/concepts/pusd)
const ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged USDC.e
const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // native USDC
const ONRAMP_IFACE = new utils.Interface([
  "function wrap(address _asset, address _to, uint256 _amount)",
]);
// Spenders that must be approved from the deposit wallet for V2 trading.
const SPENDERS = [CONFIG.exchangeV2, CONFIG.negRiskExchangeV2, CONFIG.negRiskAdapter].filter(Boolean);

const ERC20_IFACE = new utils.Interface([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERC1155_IFACE = new utils.Interface([
  "function setApprovalForAll(address,bool)",
  "function isApprovedForAll(address,address) view returns (bool)",
]);

// Minimal remote BuilderConfig. We deliberately avoid importing
// @polymarket/builder-signing-sdk on the client (its local-HMAC path pulls in
// node:crypto, which browsers can't bundle) — RelayClient only ever calls
// isValid() and generateBuilderHeaders(), so this duck-typed object suffices.
// HMAC signing happens on our server at /api/polymarket/sign, authenticated
// with the caller's Telegram initData.
function remoteBuilderConfig() {
  return {
    isValid: () => true,
    getBuilderType: () => "REMOTE",
    async generateBuilderHeaders(method, path, body, timestamp) {
      const res = await fetch("/api/polymarket/sign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${
            (typeof window !== "undefined" && window.Telegram?.WebApp?.initData) || ""
          }`,
        },
        body: JSON.stringify({ method, path, body, timestamp }),
      });
      if (!res.ok) return undefined;
      return res.json();
    },
  };
}

function buildRelayer(wallet) {
  return new RelayClient(RELAYER_URL, 137, wallet, remoteBuilderConfig(), undefined, { chain: CHAIN });
}

export async function deriveDepositAddress(wallet) {
  return buildRelayer(wallet).deriveDepositWalletAddress();
}

// Idempotent: deploys the wallet if missing, grants any missing approvals.
export async function ensureDepositAccount(wallet, onProgress) {
  const provider = getProvider();
  const relayer = buildRelayer(wallet);

  onProgress?.("Deriving your trading address…");
  const depositWallet = await relayer.deriveDepositWalletAddress();

  const code = await provider.getCode(depositWallet);
  if (!code || code === "0x") {
    onProgress?.("Creating your account (gasless)…");
    const res = await relayer.deployDepositWallet();
    // wait() resolves at STATE_MINED — but the relayer's wallet registry may
    // not be updated yet, and batches submitted before STATE_CONFIRMED fail
    // with "wallet is not registered". Poll to full confirmation.
    const tx = await res.wait();
    if (tx?.state !== "STATE_CONFIRMED") {
      onProgress?.("Registering your account…");
      await relayer.pollUntilState(
        res.transactionID, ["STATE_CONFIRMED"], "STATE_FAILED", 200
      );
    }
  }

  // Check approvals as the deposit wallet (owner-EOA approvals don't count).
  onProgress?.("Checking permissions…");
  const pusd = new Contract(CONFIG.collateral, ERC20_IFACE, provider);
  const ctf = new Contract(CONFIG.conditionalTokens, ERC1155_IFACE, provider);

  const calls = [];
  for (const spender of SPENDERS) {
    const [allowance, approvedAll] = await Promise.all([
      pusd.allowance(depositWallet, spender),
      ctf.isApprovedForAll(depositWallet, spender),
    ]);
    if (allowance.isZero())
      calls.push({
        target: CONFIG.collateral,
        value: "0",
        data: ERC20_IFACE.encodeFunctionData("approve", [spender, constants.MaxUint256]),
      });
    if (!approvedAll)
      calls.push({
        target: CONFIG.conditionalTokens,
        value: "0",
        data: ERC1155_IFACE.encodeFunctionData("setApprovalForAll", [spender, true]),
      });
  }

  if (calls.length) {
    onProgress?.("Enabling trading (gasless)…");
    // Even after deploy confirmation, registry propagation can lag a beat —
    // retry the batch when the relayer says the wallet isn't registered yet.
    let lastErr = null;
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        const deadline = String(Math.floor(Date.now() / 1000) + 600);
        const res = await relayer.executeDepositWalletBatch(calls, depositWallet, deadline);
        await res.wait();
        lastErr = null;
        break;
      } catch (e) {
        const msg = JSON.stringify(e?.message || e || "");
        if (!/not registered/i.test(msg)) throw e;
        lastErr = e;
        onProgress?.(`Waiting for account registration… (${attempt}/12)`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (lastErr)
      throw new Error(
        "Your account was created but registration is still propagating. Wait a minute and tap Create trading account again — it will pick up where it left off."
      );
  }

  return { depositWallet, approvalsGranted: calls.length };
}

export async function getDepositBalance(depositWallet) {
  const provider = getProvider();
  const pusd = new Contract(CONFIG.collateral, ERC20_IFACE, provider);
  const bal = await pusd.balanceOf(depositWallet);
  return Number(utils.formatUnits(bal, 6));
}


// What the deposit wallet actually holds — pUSD counts as tradable; raw USDC
// sent directly to the address does NOT until it's wrapped.
export async function getFundingBreakdown(depositWallet) {
  const provider = getProvider();
  const bal = async (token) => {
    try {
      const c = new Contract(token, ERC20_IFACE, provider);
      return Number(utils.formatUnits(await c.balanceOf(depositWallet), 6));
    } catch { return 0; }
  };
  const [pusd, usdce, usdc] = await Promise.all([
    bal(CONFIG.collateral), bal(USDC_E), bal(USDC_NATIVE),
  ]);
  return { pusd, usdce, usdc, wrappable: usdce + usdc };
}

// Gasless: wrap USDC.e sitting in the deposit wallet into pUSD via the
// CollateralOnramp. Per docs the onramp accepts ONLY USDC.e — native USDC
// cannot be wrapped here, so we never include it (that was the revert cause).
export async function wrapToTradable(wallet, depositWallet, onProgress) {
  const provider = getProvider();
  const relayer = buildRelayer(wallet);

  const usdce = new Contract(USDC_E, ERC20_IFACE, provider);
  const raw = await usdce.balanceOf(depositWallet);
  if (raw.isZero()) {
    // Nothing wrappable. If native USDC is present, tell the caller — it needs
    // to be swapped to USDC.e first (or deposited via Polymarket's bridge).
    const native = new Contract(USDC_NATIVE, ERC20_IFACE, provider);
    const nativeBal = await native.balanceOf(depositWallet);
    if (!nativeBal.isZero())
      throw new Error(
        "Your funds are native USDC, which the wrap contract doesn't accept. " +
        "Send USDC.e (bridged USDC) on Polygon instead, or deposit through " +
        "Polymarket's own bridge which auto-converts."
      );
    return { wrapped: 0 };
  }

  onProgress?.("Converting to trading balance (gasless)…");
  const calls = [
    {
      target: USDC_E,
      value: "0",
      data: ERC20_IFACE.encodeFunctionData("approve", [ONRAMP, raw]),
    },
    {
      target: ONRAMP,
      value: "0",
      data: ONRAMP_IFACE.encodeFunctionData("wrap", [USDC_E, depositWallet, raw]),
    },
  ];
  const deadline = String(Math.floor(Date.now() / 1000) + 600);
  const res = await relayer.executeDepositWalletBatch(calls, depositWallet, deadline);
  await res.wait();
  return { wrapped: 1 };
}
