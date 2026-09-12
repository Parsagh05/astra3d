import type { NextConfig } from "next";

/**
 * Next blocks cross-origin dev requests by default, which 403s every
 * /_next/static chunk when a phone opens the studio over the LAN address.
 * The page then renders but never hydrates, so the capture button and the
 * 12/36 photo toggle do nothing (native links still work, since they need
 * no JavaScript — which is exactly how the bug shows up on a phone).
 *
 * `next dev` runs inside Docker, so the server only ever sees the container's
 * internal address (e.g. 172.18.0.2) and never the host's real LAN IP that
 * the phone connects to — so we cannot detect the address to trust. Instead
 * we trust the private IPv4 ranges plus .local mDNS names: phone testing then
 * works on any network without pinning an address that changes, while public
 * origins stay blocked.
 */
const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "10.*.*.*",
    "172.*.*.*",
    "192.168.*.*",
    "*.local",
  ],
  turbopack: {
    root: process.cwd(),
  },
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
};

export default nextConfig;
