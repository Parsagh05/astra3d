import type { FlagshipTour } from "@/types/tour";

const panorama = (scene: "arrival" | "collection" | "lounge", alt: string) => ({
  desktop: {
    src: `/images/tours/flagship/${scene}-2048.webp`,
    width: 2048,
    height: 1024,
  },
  mobile: {
    src: `/images/tours/flagship/${scene}-1280.webp`,
    width: 1280,
    height: 640,
  },
  poster: {
    src: `/images/tours/flagship/${scene}-poster.webp`,
    width: 960,
    height: 540,
  },
  alt,
});

export const flagshipTour = {
  id: "astra-flagship",
  eyebrow: "Interactive flagship · Demonstration",
  title: "Astra Atelier",
  description:
    "Explore a fictional fashion flagship, move between three spaces, and open product and story hotspots. All products, prices, and availability are demonstration content.",
  venueLabel: "Astra Atelier — Digital flagship",
  initialSceneId: "arrival",
  map: {
    label: "Flagship floor plan",
    description:
      "A single-level route connecting Arrival, Collection, and Private Lounge.",
    aspectRatio: 1.7,
  },
  scenes: [
    {
      id: "arrival",
      sequence: 1,
      label: "Arrival",
      title: "The gallery threshold",
      description:
        "A calm introduction to the flagship, framed by illuminated vitrines and a central sculptural display.",
      panorama: panorama(
        "arrival",
        "Panoramic view of a contemporary fashion flagship arrival gallery with a circular display, illuminated wall vitrines, and open passages",
      ),
      initialView: { yaw: 0, pitch: -2, fieldOfView: 76 },
      mapPosition: { x: 19, y: 51 },
      hotspots: [
        {
          id: "arrival-collection",
          label: "Enter Collection",
          ariaLabel: "Move from Arrival to the Collection room",
          yaw: -34,
          pitch: -1,
          fallbackPosition: { x: 31, y: 47 },
          action: {
            type: "navigate",
            targetSceneId: "collection",
            destinationLabel: "Collection room",
          },
        },
        {
          id: "arrival-lounge",
          label: "Visit Private Lounge",
          ariaLabel: "Move from Arrival to the Private Lounge",
          yaw: 34,
          pitch: -1,
          fallbackPosition: { x: 71, y: 48 },
          action: {
            type: "navigate",
            targetSceneId: "lounge",
            destinationLabel: "Private Lounge",
          },
        },
        {
          id: "arrival-installation",
          label: "About the installation",
          ariaLabel: "Open details about the central material study",
          yaw: 1,
          pitch: -14,
          fallbackPosition: { x: 52, y: 61 },
          action: {
            type: "info",
            eyebrow: "Flagship story",
            title: "Material in motion",
            description:
              "The arrival display pairs brushed metal, mineral surfaces, and directional light to introduce the collection through texture rather than signage.",
            facts: [
              { label: "Experience", value: "Self-guided" },
              { label: "Environment", value: "Fictional concept" },
            ],
          },
        },
        {
          id: "arrival-folio",
          label: "Axis travel folio",
          ariaLabel: "Open product details for the Axis travel folio",
          yaw: -77,
          pitch: -5,
          fallbackPosition: { x: 10, y: 47 },
          action: {
            type: "product",
            productId: "axis-travel-folio",
          },
        },
      ],
    },
    {
      id: "collection",
      sequence: 2,
      label: "Collection",
      title: "The collection room",
      description:
        "Signature accessories and tailored pieces are staged with room to inspect form, finish, and detail.",
      panorama: panorama(
        "collection",
        "Panoramic view of a premium fashion collection room with navy display walls, tailored garments, shoes, bags, and two curved tables",
      ),
      initialView: { yaw: 0, pitch: -3, fieldOfView: 78 },
      mapPosition: { x: 51, y: 31 },
      hotspots: [
        {
          id: "collection-arrival",
          label: "Return to Arrival",
          ariaLabel: "Move from Collection back to Arrival",
          yaw: -70,
          pitch: 0,
          fallbackPosition: { x: 18, y: 48 },
          action: {
            type: "navigate",
            targetSceneId: "arrival",
            destinationLabel: "Arrival",
          },
        },
        {
          id: "collection-lounge",
          label: "Continue to Lounge",
          ariaLabel: "Move from Collection to the Private Lounge",
          yaw: 65,
          pitch: 0,
          fallbackPosition: { x: 82, y: 48 },
          action: {
            type: "navigate",
            targetSceneId: "lounge",
            destinationLabel: "Private Lounge",
          },
        },
        {
          id: "collection-loafer",
          label: "Meridian loafer",
          ariaLabel: "Open product details for the Meridian loafer",
          yaw: -12,
          pitch: -17,
          fallbackPosition: { x: 43, y: 68 },
          action: {
            type: "product",
            productId: "meridian-loafer",
          },
        },
        {
          id: "collection-bag",
          label: "Orbit mini bag",
          ariaLabel: "Open product details for the Orbit mini bag",
          yaw: 21,
          pitch: -15,
          fallbackPosition: { x: 61, y: 65 },
          action: {
            type: "product",
            productId: "orbit-mini-bag",
          },
        },
        {
          id: "collection-tailoring",
          label: "Tailoring notes",
          ariaLabel: "Open details about the collection wall",
          yaw: 0,
          pitch: 1,
          fallbackPosition: { x: 51, y: 39 },
          action: {
            type: "info",
            eyebrow: "Collection story",
            title: "A study in proportion",
            description:
              "The collection wall moves from compact layers to longer silhouettes, inviting visitors to compare shape and material at a glance.",
            facts: [
              { label: "Edit", value: "Seasonal concept" },
              { label: "Items shown", value: "Demonstration only" },
            ],
          },
        },
      ],
    },
    {
      id: "lounge",
      sequence: 3,
      label: "Private Lounge",
      title: "A quieter point of view",
      description:
        "A private setting for focused product discovery, finish comparison, and a considered end to the visit.",
      panorama: panorama(
        "lounge",
        "Panoramic view of a private fashion lounge with a curved navy sofa, central bag display, fitting-room curtains, and mirrored passages",
      ),
      initialView: { yaw: 0, pitch: -3, fieldOfView: 76 },
      mapPosition: { x: 80, y: 55 },
      hotspots: [
        {
          id: "lounge-collection",
          label: "Return to Collection",
          ariaLabel: "Move from the Private Lounge back to Collection",
          yaw: 35,
          pitch: 0,
          fallbackPosition: { x: 68, y: 47 },
          action: {
            type: "navigate",
            targetSceneId: "collection",
            destinationLabel: "Collection room",
          },
        },
        {
          id: "lounge-arrival",
          label: "Return to Arrival",
          ariaLabel: "Move from the Private Lounge back to Arrival",
          yaw: -20,
          pitch: 0,
          fallbackPosition: { x: 43, y: 47 },
          action: {
            type: "navigate",
            targetSceneId: "arrival",
            destinationLabel: "Arrival",
          },
        },
        {
          id: "lounge-bag",
          label: "Orbit mini bag",
          ariaLabel: "Open product details for the Orbit mini bag",
          yaw: 1,
          pitch: -17,
          fallbackPosition: { x: 52, y: 64 },
          action: {
            type: "product",
            productId: "orbit-mini-bag",
          },
        },
        {
          id: "lounge-service",
          label: "Private appointment",
          ariaLabel: "Open information about private appointment service",
          yaw: -62,
          pitch: -7,
          fallbackPosition: { x: 18, y: 57 },
          action: {
            type: "info",
            eyebrow: "Client service",
            title: "Continue with a specialist",
            description:
              "In a connected production experience, this moment could open a booking or contact flow. This local tour keeps the interaction in demonstration mode.",
            facts: [
              { label: "Format", value: "Virtual or in-store" },
              { label: "Status", value: "Concept interaction" },
            ],
          },
        },
      ],
    },
  ],
  products: [
    {
      id: "orbit-mini-bag",
      eyebrow: "Astra Atelier · Edition 01",
      name: "Orbit mini bag",
      description:
        "A compact architectural bag with a curved body, softened edges, and a low-profile metal closure.",
      details: ["Adjustable shoulder strap", "Microfibre lining", "18 × 13 × 7 cm"],
      finishes: [
        {
          id: "midnight",
          name: "Midnight",
          material: "Smooth plant-based leather",
          swatch: "#111a2b",
        },
        {
          id: "mineral",
          name: "Mineral",
          material: "Fine-grain plant-based leather",
          swatch: "#c9c4b9",
        },
        {
          id: "oxide",
          name: "Oxide",
          material: "Brushed metallic textile",
          swatch: "#957c68",
        },
      ],
      defaultFinishId: "midnight",
      commerce: {
        mode: "local-demo",
        sku: "DEMO-AA-ORB-01",
        currency: "USD",
        unitAmount: 68000,
        displayPrice: "$680",
        availabilityLabel: "Demo availability",
        ctaLabel: "Add to demo bag",
        disclosure:
          "Demonstration product only. No order, payment, or inventory request will be submitted.",
      },
    },
    {
      id: "meridian-loafer",
      eyebrow: "Astra Atelier · Core form",
      name: "Meridian loafer",
      description:
        "A streamlined slip-on defined by a squared toe, sculpted welt, and understated tonal construction.",
      details: ["Leather-free upper", "Cushioned footbed", "European sizing 36–46"],
      finishes: [
        {
          id: "ink",
          name: "Ink",
          material: "Polished bio-based composite",
          swatch: "#17191f",
        },
        {
          id: "chalk",
          name: "Chalk",
          material: "Matte bio-based composite",
          swatch: "#e6e1d8",
        },
        {
          id: "navy",
          name: "Deep navy",
          material: "Fine-grain recycled textile",
          swatch: "#182741",
        },
      ],
      defaultFinishId: "ink",
      commerce: {
        mode: "local-demo",
        sku: "DEMO-AA-MER-02",
        currency: "USD",
        unitAmount: 42000,
        displayPrice: "$420",
        availabilityLabel: "Demo availability",
        ctaLabel: "Add to demo bag",
        disclosure:
          "Demonstration product only. No order, payment, or inventory request will be submitted.",
      },
    },
    {
      id: "axis-travel-folio",
      eyebrow: "Astra Atelier · Travel object",
      name: "Axis travel folio",
      description:
        "A slim document folio with an asymmetric fold, magnetic closure, and considered internal organization.",
      details: ["Three document sleeves", "Magnetic tab closure", "Fits tablets up to 11 inches"],
      finishes: [
        {
          id: "navy",
          name: "Deep navy",
          material: "Recycled technical weave",
          swatch: "#15223a",
        },
        {
          id: "stone",
          name: "Warm stone",
          material: "Textured plant-based leather",
          swatch: "#b0a89c",
        },
        {
          id: "cobalt",
          name: "Cobalt",
          material: "Recycled technical weave",
          swatch: "#245f9c",
        },
      ],
      defaultFinishId: "navy",
      commerce: {
        mode: "local-demo",
        sku: "DEMO-AA-AXS-03",
        currency: "USD",
        unitAmount: 29000,
        displayPrice: "$290",
        availabilityLabel: "Demo availability",
        ctaLabel: "Add to demo bag",
        disclosure:
          "Demonstration product only. No order, payment, or inventory request will be submitted.",
      },
    },
  ],
} as const satisfies FlagshipTour;

export const flagshipScenes = flagshipTour.scenes;

export const flagshipProducts = flagshipTour.products;
