// In-app trading wallet (client-side only).
// Key never leaves the device unencrypted: PIN → PBKDF2 → AES-GCM,
// ciphertext stored in Telegram CloudStorage (localStorage fallback for dev).

import { Wallet, providers, Contract, constants, utils } from "ethers";
import { getContractConfig } from "@polymarket/clob-client-v2";

const RPC = process.env.NEXT_PUBLIC_POLYGON_RPC || "https://polygon-rpc.com";
const STORE_KEY = "fadebot_wallet_v1";

export const CONTRACTS = getContractConfig(137);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const ERC1155_ABI = [
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
];

// Spenders that need collateral/CTF approvals for V2 trading
// (V1 exchanges included for safety during the migration window).
const SPENDERS = [
  CONTRACTS.exchangeV2,
  CONTRACTS.negRiskExchangeV2,
  CONTRACTS.negRiskAdapter,
  CONTRACTS.exchange,
  CONTRACTS.negRiskExchange,
].filter(Boolean);

export function getProvider() {
  return new providers.JsonRpcProvider(RPC, 137);
}

// ── Storage (Telegram CloudStorage with dev fallback) ─────────
function cloud() {
  return typeof window !== "undefined" ? window.Telegram?.WebApp?.CloudStorage : null;
}
function storeSet(value) {
  const c = cloud();
  if (c?.setItem)
    return new Promise((res, rej) =>
      c.setItem(STORE_KEY, value, (e, ok) => (e ? rej(new Error(e)) : res(ok)))
    );
  localStorage.setItem(STORE_KEY, value);
  return Promise.resolve(true);
}
function storeGet() {
  const c = cloud();
  if (c?.getItem)
    return new Promise((res, rej) =>
      c.getItem(STORE_KEY, (e, v) => (e ? rej(new Error(e)) : res(v || null)))
    );
  return Promise.resolve(localStorage.getItem(STORE_KEY));
}
function storeRemove() {
  const c = cloud();
  if (c?.removeItem)
    return new Promise((res) => c.removeItem(STORE_KEY, () => res(true)));
  localStorage.removeItem(STORE_KEY);
  return Promise.resolve(true);
}

// ── PIN crypto (WebCrypto: PBKDF2 → AES-GCM) ─────────────────
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt) {
  const material = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSecret(pin, secretHex) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(secretHex));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

export async function decryptSecret(pin, blob) {
  const { salt, iv, ct } = JSON.parse(blob);
  const key = await deriveKey(pin, unb64(salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
  return new TextDecoder().decode(pt);
}

// ── Wallet lifecycle ──────────────────────────────────────────
// Store format v2: { v:2, cipher, funder, sigType }
//   sigType 0 = standalone EOA (needs funding + approvals)
//   sigType 1 = Polymarket email/Google account (proxy — gasless, pre-approved)
//   sigType 2 = Polymarket crypto-wallet account (Gnosis Safe — gasless, pre-approved)
async function readStore() {
  const raw = await storeGet();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.v === 2) return parsed;
    if (parsed?.v === 1) return { v: 2, cipher: raw, funder: null, sigType: 0 }; // legacy
  } catch { /* fall through */ }
  return null;
}

export async function hasWallet() {
  return Boolean(await readStore());
}

export async function updateWalletMeta(meta) {
  const st = await readStore();
  if (!st) throw new Error("No wallet to update.");
  await storeSet(JSON.stringify({ ...st, ...meta }));
}

export async function getWalletMeta() {
  const st = await readStore();
  return st ? { funder: st.funder, sigType: st.sigType ?? 0 } : null;
}

async function save(pin, privateKey, meta) {
  const cipher = await encryptSecret(pin, privateKey);
  await storeSet(JSON.stringify({ v: 2, cipher, ...meta }));
}

export async function createWallet(pin) {
  const w = Wallet.createRandom();
  await save(pin, w.privateKey, { funder: w.address, sigType: 0 });
  return { address: w.address };
}

export async function importWallet(pin, privateKey, meta = null) {
  const w = new Wallet(privateKey.trim()); // throws on invalid key
  await save(pin, w.privateKey, meta || { funder: w.address, sigType: 0 });
  return { address: w.address };
}

export async function unlockWallet(pin) {
  const st = await readStore();
  if (!st) throw new Error("No wallet on this device yet.");
  let pk;
  try {
    pk = await decryptSecret(pin, st.cipher);
  } catch {
    throw new Error("Wrong PIN.");
  }
  const wallet = new Wallet(pk, getProvider());
  return { wallet, funder: st.funder || wallet.address, sigType: st.sigType ?? 0 };
}

export async function deleteWallet() {
  return storeRemove();
}

// ── Balances ──────────────────────────────────────────────────
export async function getBalances(address) {
  const provider = getProvider();
  const collateral = new Contract(CONTRACTS.collateral, ERC20_ABI, provider);
  const [pol, col, decimals] = await Promise.all([
    provider.getBalance(address),
    collateral.balanceOf(address),
    collateral.decimals().catch(() => 6),
  ]);
  return {
    pol: Number(utils.formatEther(pol)),
    collateral: Number(utils.formatUnits(col, decimals)),
  };
}

// ── One-time trading approvals (needs a little POL for gas) ──
export async function missingApprovals(address) {
  const provider = getProvider();
  const erc20 = new Contract(CONTRACTS.collateral, ERC20_ABI, provider);
  const ctf = new Contract(CONTRACTS.conditionalTokens, ERC1155_ABI, provider);
  const missing = [];
  for (const spender of SPENDERS) {
    const [allowance, approved] = await Promise.all([
      erc20.allowance(address, spender),
      ctf.isApprovedForAll(address, spender),
    ]);
    if (allowance.isZero()) missing.push({ kind: "erc20", spender });
    if (!approved) missing.push({ kind: "erc1155", spender });
  }
  return missing;
}

export async function grantApprovals(wallet, onProgress) {
  const { pol } = await getBalances(wallet.address);
  if (pol < 0.05)
    throw new Error("Approvals need a little POL for gas (~0.05). Send POL to your trading wallet first.");

  const erc20 = new Contract(CONTRACTS.collateral, ERC20_ABI, wallet);
  const ctf = new Contract(CONTRACTS.conditionalTokens, ERC1155_ABI, wallet);
  const missing = await missingApprovals(wallet.address);

  let done = 0;
  for (const m of missing) {
    onProgress?.(`Approving ${++done}/${missing.length}…`);
    const tx =
      m.kind === "erc20"
        ? await erc20.approve(m.spender, constants.MaxUint256)
        : await ctf.setApprovalForAll(m.spender, true);
    await tx.wait();
  }
  return missing.length;
}
