"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { polygon } from "viem/chains";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

// Feature-flagged: without NEXT_PUBLIC_PRIVY_APP_ID the app runs exactly as
// before (PIN-wallet fallback), so a missing Privy setup can never break prod.
export default function Providers({ children }) {
  if (!APP_ID) return children;
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["telegram"],
        appearance: { theme: "dark", accentColor: "#37E0C8", logo: undefined },
        defaultChain: polygon,
        supportedChains: [polygon],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
