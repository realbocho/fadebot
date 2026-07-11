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
    await res.wait();
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
    const deadline = String(Math.floor(Date.now() / 1000) + 600);
    const res = await relayer.executeDepositWalletBatch(calls, depositWallet, deadline);
    await res.wait();
  }

  return { depositWallet, approvalsGranted: calls.length };
}

export async function getDepositBalance(depositWallet) {
  const provider = getProvider();
  const pusd = new Contract(CONFIG.collateral, ERC20_IFACE, provider);
  const bal = await pusd.balanceOf(depositWallet);
  return Number(utils.formatUnits(bal, 6));
}
