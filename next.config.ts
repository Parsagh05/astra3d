import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

/**
 * Next blocks cross-origin dev requests by default, which 403s every
 * /_next/static chunk when a phone opens the studio over the LAN address.
 * The page then renders but never hydrates, so the capture button does
 * nothing. Trusting this machine's own LAN addresses keeps phone testing
 * working without pinning an address that changes with the network.
 */
const lanDevOrigins = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal)
  .map((address) => address.address);

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost", ...lanDevOrigins],
  turbopack: {
    root: process.cwd(),
  },
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
};

export default nextConfig;
