import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./globals.css";

const siteUrl = "https://astra3d.com";
const siteTitle = "Astra3D — Immersive Spatial Commerce";
const siteDescription =
  "Build and explore immersive 3D experiences for digital commerce, real estate, hospitality, and art—directly in the browser.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: "%s | Astra3D",
  },
  description: siteDescription,
  applicationName: "Astra3D",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Astra3D",
    title: siteTitle,
    description: siteDescription,
    images: [
      {
        url: "/images/og-cover.webp",
        width: 1200,
        height: 630,
        alt: "A cinematic virtual retail environment created for Astra3D",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: ["/images/og-cover.webp"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
  themeColor: "#050b14",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" id="top">
      <body>{children}</body>
    </html>
  );
}
