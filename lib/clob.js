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
    return Number(r?.balance ?? 0) / 1e6; // collateral has 6 decimals
  } catch {
    return null;
  }
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

export function builderCodeConfigured() {
  return Boolean(BUILDER_CODE);
}
