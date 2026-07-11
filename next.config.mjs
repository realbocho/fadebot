/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // Privy optionally references Stripe's fiat-onramp SDK; we don't use it.
    // Privy optionally references onramp/Farcaster/Solana integrations we don't use.
    for (const mod of [
      "@stripe/crypto",
      "@stripe/stripe-js",
      "@farcaster/mini-app-solana",
      "@solana/web3.js",
      "@solana/kit",
    ]) config.resolve.alias[mod] = false;
    return config;
  },
};
export default nextConfig;
