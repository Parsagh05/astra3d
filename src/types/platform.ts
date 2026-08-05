export type ExperienceIndustry =
  | "Retail"
  | "Real Estate"
  | "Hospitality"
  | "Art";

export type DeviceSupport = "Web" | "Mobile" | "Tablet";

export type HotspotPosition = {
  x: number;
  y: number;
};

export type Hotspot = {
  id: string;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  position: HotspotPosition;
};

export type Experience = {
  id: string;
  industry: ExperienceIndustry;
  title: string;
  description: string;
  image: string;
  imageAlt: string;
  accent: string;
  deviceSupport: readonly DeviceSupport[];
  hotspots: readonly Hotspot[];
};

export type CapabilityIcon =
  | "hotspots"
  | "commerce"
  | "analytics"
  | "devices"
  | "branding"
  | "integrations";

export type Capability = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: CapabilityIcon;
  layout: "standard" | "wide";
  signal: string;
};

export type LeadRequest = {
  fullName: string;
  workEmail: string;
  company: string;
  industry: ExperienceIndustry | "Other";
  message?: string;
};

export type WorkflowStep = {
  id: string;
  number: string;
  label: string;
  title: string;
  description: string;
  icon: "import" | "customize" | "launch";
};

export type DashboardMetric = {
  label: string;
  value: string;
  change: string;
  direction: "up" | "steady";
};

export type TrafficPoint = {
  label: string;
  value: number;
};

export type InventoryItem = {
  name: string;
  category: string;
  engagements: number;
  status: "Live" | "Review";
};
