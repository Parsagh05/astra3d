const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Astra3D",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web browser",
  url: "https://astra3d.com",
  description:
    "An original browser-based spatial commerce demonstration with a navigable three-room 360-degree flagship, interactive hotspots, a floor plan, and local product previews.",
  image: "https://astra3d.com/images/og-cover.webp",
  browserRequirements:
    "Requires JavaScript. WebGL provides the enhanced panorama and product views; accessible static fallbacks are included.",
  featureList: [
    "Three linked 360-degree retail scenes",
    "Pointer, touch, and keyboard panorama controls",
    "Navigation, information, and product hotspots",
    "Interactive floor plan",
    "Local demonstration product viewer and bag",
    "Shareable scene and hotspot links",
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
