const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Astra3D",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web browser",
  url: "https://astra3d.com",
  description:
    "A browser-based room capture and spatial experience platform that guides smartphone users through a private single-room 360 panorama workflow.",
  image: "https://astra3d.com/images/og-cover.webp",
  browserRequirements:
    "Requires JavaScript. WebGL provides the enhanced panorama and product views; accessible static fallbacks are included.",
  featureList: [
    "Guided 24-photo smartphone room capture",
    "Private laptop-side 2:1 panorama assembly",
    "Persistent private room preview and panorama download",
    "Three linked 360-degree retail scenes",
    "Pointer, touch, and keyboard panorama controls",
    "Navigation, information, and product hotspots",
    "Interactive floor plan",
    "Local demonstration product viewer and bag",
    "Shareable demonstration scene and hotspot links",
  ],
};

export function SeoStructuredData() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
      }}
    />
  );
}
