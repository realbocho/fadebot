// Polymarket CLOB V2 trading (client-side). Every order carries the builder
// code, which is how routed volume — and fees — are attributed to FadeBot.

import { ClobClient, Side, OrderType, AssetType } from "@polymarket/clob-client-v2";

const HOST = "https://clob.polymarket.com";
const BUILDER_CODE = process.env.NEXT_PUBLIC_BUILDER_CODE || "";

// L1 auth (wallet signature) → API creds → fully-authed client.
// sigType/funder: 0/own address for standalone EOA; 1 or 2 with the
// Polymarket account address to trade directly from a Polymarket balance.
export async function createTradingClient(wallet, { sigType = 0, funder } = {}) {
  const bootstrap = new ClobClient({ host: HOST, chain: 137, signer: wallet });
  const creds = await bootstrap.createOrDeriveApiKey();
  return new ClobClient({
    host: HOST,
    chain: 137,
    signer: wallet,
    creds,
    signatureType: sigType,
    funderAddress: funder || wallet.address,
  });
}

// Balance as the CLOB sees it (source of truth for order acceptance).
export async function getClobBalance(client) {
  try {
    const r = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    // balance is a 6-decimal integer string. Guard against shape differences —
    // a NaN here must read as "unknown" (null), never poison comparisons.
    const raw = r?.balance ?? r?.collateral ?? 0;
    const n = Number(raw) / 1e6;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Read raw balance-allowance response for diagnostics.
export async function getClobBalanceRaw(client) {
  try {
    return await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// The CLOB caches balances server-side; it must be refreshed before it will
// report a freshly-funded or newly-connected account. Required for every
// account type, not just deposit wallets — without it a real balance can read
// as $0. Safe to call any time.
export async function syncClobBalance(client) {
  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch { /* cache update is best-effort */ }
  return getClobBalance(client);
}

// Market metadata the order needs (tick size, neg-risk) — ask the CLOB
// directly so the EIP-712 signature always matches what it expects.
export async function getOrderParams(client, tokenID) {
  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenID),
    client.getNegRisk(tokenID),
  ]);
  return { tickSize: String(tickSize), negRisk: Boolean(negRisk) };
}

// Fill-or-kill market buy: `usd` is spent at the best available prices.
export async function placeMarketBuy(client, { tokenID, usd }) {
  if (!BUILDER_CODE)
    throw new Error("Builder code missing — set NEXT_PUBLIC_BUILDER_CODE and redeploy.");

  const { tickSize, negRisk } = await getOrderParams(client, tokenID);
  return client.createAndPostMarketOrder(
    {
      tokenID,
      amount: usd, // BUY: dollar amount
      side: Side.BUY,
      builderCode: BUILDER_CODE,
    },
    { tickSize, negRisk },
    OrderType.FOK
  );
}

// Fill-or-kill market sell: `shares` outcome tokens are sold at the best
// available prices. Proceeds land as pUSD in the funder wallet.
export async function placeMarketSell(client, { tokenID, shares }) {
  if (!BUILDER_CODE)
    throw new Error("Builder code missing — set NEXT_PUBLIC_BUILDER_CODE and redeploy.");

  const { tickSize, negRisk } = await getOrderParams(client, tokenID);
  return client.createAndPostMarketOrder(
    {
      tokenID,
      amount: shares, // SELL: number of shares
      side: Side.SELL,
      builderCode: BUILDER_CODE,
    },
    { tickSize, negRisk },
    OrderType.FOK
  );
}

export function builderCodeConfigured() {
  return Boolean(BUILDER_CODE);
}
