import type {
  Capability,
  DashboardMetric,
  Experience,
  InventoryItem,
  TrafficPoint,
  WorkflowStep,
} from "@/types/platform";

export const experiences = [
  {
    id: "retail",
    industry: "Retail",
    title: "A flagship that never closes.",
    description:
      "Turn every collection into a navigable story, connecting discovery, detail, and purchase in one continuous space.",
    image: "/images/experience-retail.webp",
    imageAlt:
      "Futuristic fashion boutique with illuminated displays and sculptural fixtures",
    accent: "#65e8ff",
    deviceSupport: ["Web", "Mobile", "Tablet"],
    hotspots: [
      {
        id: "retail-collection",
        label: "Collection wall",
        eyebrow: "Product discovery",
        title: "Shop the scene, not a grid.",
        description:
          "Place shoppable products directly inside the environment so context stays intact from first look to product detail.",
        position: { x: 26, y: 51 },
      },
      {
        id: "retail-story",
        label: "Story layer",
        eyebrow: "Rich media",
        title: "Let every object tell more.",
        description:
          "Open video, editorial, product specifications, or a 3D model from a single spatial hotspot.",
        position: { x: 69, y: 35 },
      },
      {
        id: "retail-checkout",
        label: "Instant checkout",
        eyebrow: "Connected commerce",
        title: "Keep momentum to the cart.",
        description:
          "Move visitors from inspiration to an existing commerce flow without breaking the sense of place.",
        position: { x: 77, y: 70 },
      },
    ],
  },
  {
    id: "real-estate",
    industry: "Real Estate",
    title: "Walk the property from anywhere.",
    description:
      "Give prospective buyers an intuitive sense of scale, finish, and flow before an in-person visit is possible.",
    image: "/images/experience-real-estate.webp",
    imageAlt:
      "Contemporary luxury residence overlooking a city through panoramic windows",
    accent: "#d4b483",
    deviceSupport: ["Web", "Mobile", "Tablet"],
    hotspots: [
      {
        id: "estate-materials",
        label: "Material palette",
        eyebrow: "Finish detail",
        title: "Make the materials tangible.",
        description:
          "Reveal finish schedules, close-up imagery, and specifications exactly where buyers encounter each material.",
        position: { x: 24, y: 68 },
      },
      {
        id: "estate-outlook",
        label: "View corridor",
        eyebrow: "Spatial context",
        title: "Frame the view that sells the room.",
        description:
          "Guide attention toward defining sightlines and explain orientation, daylight, and surrounding landmarks.",
        position: { x: 61, y: 34 },
      },
      {
        id: "estate-plan",
        label: "Floor plan",
        eyebrow: "Navigation",
        title: "Move through every room with confidence.",
        description:
          "Pair spatial navigation with a clear plan view so visitors always understand where they are.",
        position: { x: 82, y: 58 },
      },
    ],
  },
  {
    id: "hospitality",
    industry: "Hospitality",
    title: "Let the stay begin before arrival.",
    description:
      "Invite guests into the atmosphere, amenities, and signature moments that make a destination worth choosing.",
    image: "/images/experience-hospitality.webp",
    imageAlt:
      "Cinematic hotel lobby with warm lighting, reflective stone, and lounge seating",
    accent: "#ffcb8f",
    deviceSupport: ["Web", "Mobile", "Tablet"],
    hotspots: [
      {
        id: "hospitality-concierge",
        label: "Digital concierge",
        eyebrow: "Guest service",
        title: "Answer questions in the moment.",
        description:
          "Attach amenity details, opening hours, and concierge contact points to the spaces guests are exploring.",
        position: { x: 31, y: 48 },
      },
      {
        id: "hospitality-suite",
        label: "Suite preview",
        eyebrow: "Room discovery",
        title: "Turn room choice into an experience.",
        description:
          "Let guests compare room stories and move naturally into availability or booking when they are ready.",
        position: { x: 69, y: 31 },
      },
      {
        id: "hospitality-amenities",
        label: "Amenities",
        eyebrow: "Destination story",
        title: "Connect every reason to stay.",
        description:
          "Surface dining, wellness, and local experiences without sending guests into a maze of disconnected pages.",
        position: { x: 75, y: 72 },
      },
    ],
  },
  {
    id: "art",
    industry: "Art",
    title: "A gallery with infinite walls.",
    description:
      "Curate exhibitions beyond physical limits while preserving the stillness, scale, and focus each work deserves.",
    image: "/images/experience-art.webp",
    imageAlt:
      "Immersive digital art gallery with luminous installations in a dark exhibition space",
    accent: "#a796ff",
    deviceSupport: ["Web", "Mobile", "Tablet"],
    hotspots: [
      {
        id: "art-curator",
        label: "Curator note",
        eyebrow: "Interpretation",
        title: "Layer meaning without visual noise.",
        description:
          "Offer optional curatorial context, audio, and related work while the exhibition remains visually composed.",
        position: { x: 28, y: 39 },
      },
      {
        id: "art-installation",
        label: "Installation view",
        eyebrow: "Immersive media",
        title: "Present work at its intended scale.",
        description:
          "Combine spatial staging, moving image, sound, and high-resolution detail in one focused encounter.",
        position: { x: 57, y: 54 },
      },
      {
        id: "art-collect",
        label: "Collector inquiry",
        eyebrow: "Private connection",
        title: "Make interest actionable.",
        description:
          "Give collectors a direct, discreet path to availability, provenance, and gallery contact information.",
        position: { x: 80, y: 67 },
      },
    ],
  },
] as const satisfies readonly Experience[];

export const workflowSteps = [
  {
    id: "import",
    number: "01",
    label: "Import",
    title: "Bring the scene.",
    description:
      "Start with a panorama, render, or store image and let the spatial canvas establish the world around it.",
    icon: "import",
  },
  {
    id: "customize",
    number: "02",
    label: "Customize",
    title: "Shape the journey.",
    description:
      "Place products, media, navigation, and branded moments with a visual, no-code workflow.",
    icon: "customize",
  },
  {
    id: "launch",
    number: "03",
    label: "Launch",
    title: "Meet every screen.",
    description:
      "Publish one responsive experience, then learn from how people move, pause, and engage.",
    icon: "launch",
  },
] as const satisfies readonly WorkflowStep[];

export const capabilities = [
  {
    id: "hotspots",
    eyebrow: "Interaction layer",
    title: "Hotspots with a point of view.",
    description:
      "Connect products, stories, media, games, and calls to action to precise moments in the environment.",
    icon: "hotspots",
    layout: "wide",
    signal: "Place · Link · Reveal",
  },
  {
    id: "commerce",
    eyebrow: "Commerce",
    title: "A shorter path to intent.",
    description:
      "Keep product discovery and buying context connected throughout the experience.",
    icon: "commerce",
    layout: "standard",
    signal: "Cart ready",
  },
  {
    id: "analytics",
    eyebrow: "Live insight",
    title: "See what earns attention.",
    description:
      "Understand entry points, dwell, hotspot activity, and the paths visitors choose.",
    icon: "analytics",
    layout: "standard",
    signal: "Behavior mapped",
  },
  {
    id: "devices",
    eyebrow: "Responsive by design",
    title: "One world. Any screen.",
    description:
      "Create once for desktop, mobile, and tablet browsers with controls that fit each screen.",
    icon: "devices",
    layout: "standard",
    signal: "Web · Mobile · Tablet",
  },
  {
    id: "branding",
    eyebrow: "White label",
    title: "Make the space unmistakably yours.",
    description:
      "Carry identity through navigation, atmosphere, custom domains, and every branded touchpoint.",
    icon: "branding",
    layout: "standard",
    signal: "Brand system synced",
  },
  {
    id: "integrations",
    eyebrow: "Connected stack",
    title: "Built to join your ecosystem.",
    description:
      "Create clear handoffs to commerce, lead capture, media, and the tools already powering the business.",
    icon: "integrations",
    layout: "standard",
    signal: "Modular connections",
  },
] as const satisfies readonly Capability[];

export const dashboardMetrics = [
  {
    label: "Active visitors",
    value: "1,284",
    change: "+18.2%",
    direction: "up",
  },
  {
    label: "Avg. dwell time",
    value: "06:42",
    change: "+00:38",
    direction: "up",
  },
  {
    label: "Hotspot opens",
    value: "3,891",
    change: "Steady",
    direction: "steady",
  },
] as const satisfies readonly DashboardMetric[];

export const trafficSeries = [
  { label: "Mon", value: 42 },
  { label: "Tue", value: 57 },
  { label: "Wed", value: 49 },
  { label: "Thu", value: 68 },
  { label: "Fri", value: 63 },
  { label: "Sat", value: 82 },
  { label: "Sun", value: 76 },
] as const satisfies readonly TrafficPoint[];

export const inventoryItems = [
  {
    name: "Arc lounge chair",
    category: "Furniture",
    engagements: 342,
    status: "Live",
  },
  {
    name: "Form floor lamp",
    category: "Lighting",
    engagements: 278,
    status: "Live",
  },
  {
    name: "Edition 04 print",
    category: "Artwork",
    engagements: 164,
    status: "Review",
  },
] as const satisfies readonly InventoryItem[];
