const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Astra3D",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web browser",
  url: "https://astra3d.com",
  description:
    "A platform for creating immersive 3D experiences for digital commerce, real estate, hospitality, and art.",
  image: "https://astra3d.com/images/og-cover.webp",
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
