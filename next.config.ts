import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Type safety is enforced via `tsc --noEmit` separately.
    ignoreBuildErrors: true,
  },
  serverExternalPackages: [
    "@circle-fin/w3s-pw-web-sdk",
    "@circle-fin/developer-controlled-wallets",
    "@circle-fin/x402-batching",
  ],
  experimental: {
    optimizePackageImports: [
      "@phosphor-icons/react",
      "viem",
      "ethers",
    ],
  },
};

export default nextConfig;
