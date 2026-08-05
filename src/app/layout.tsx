import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./globals.css";

const siteUrl = "https://astra3d.com";
const siteTitle = "Astra3D — Interactive 360° Commerce Tour";
const siteDescription =
  "Explore a functional three-room 360° retail flagship with spatial navigation, interactive hotspots, a floor plan, and local product previews—directly in the browser.";

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
        alt: "Cinematic retail environment used in the Astra3D interactive flagship demonstration",
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
      <head>
        <link
          rel="preload"
          href="/images/experience-retail.webp"
          as="image"
          type="image/webp"
          fetchPriority="high"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
