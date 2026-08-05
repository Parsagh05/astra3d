export type FlagshipSceneId = "arrival" | "collection" | "lounge";

export type FlagshipProductId =
  | "orbit-mini-bag"
  | "meridian-loafer"
  | "axis-travel-folio";

export type TourImageAsset = {
  src: string;
  width: number;
  height: number;
};

export type TourPanorama = {
  desktop: TourImageAsset;
  mobile: TourImageAsset;
  poster: TourImageAsset;
  alt: string;
};

/** Angular values used by a panorama renderer, expressed in degrees. */
export type TourView = {
  yaw: number;
  pitch: number;
  fieldOfView: number;
};

/** A percentage position within the static poster or code-built floor plan. */
export type TourPosition = {
  x: number;
  y: number;
};

export type NavigateHotspotAction = {
  type: "navigate";
  targetSceneId: FlagshipSceneId;
  destinationLabel: string;
};

export type InfoHotspotAction = {
  type: "info";
  eyebrow: string;
  title: string;
  description: string;
  facts?: readonly {
    label: string;
    value: string;
  }[];
};

export type ProductHotspotAction = {
  type: "product";
  productId: FlagshipProductId;
};

export type TourHotspotAction =
  | NavigateHotspotAction
  | InfoHotspotAction
  | ProductHotspotAction;

export type TourHotspot = {
  id: string;
  label: string;
  ariaLabel: string;
  yaw: number;
  pitch: number;
  fallbackPosition: TourPosition;
  action: TourHotspotAction;
};

export type TourScene = {
  id: FlagshipSceneId;
  sequence: number;
  label: string;
  title: string;
  description: string;
  panorama: TourPanorama;
  initialView: TourView;
  mapPosition: TourPosition;
  hotspots: readonly TourHotspot[];
};

export type ProductFinish = {
  id: string;
  name: string;
  material: string;
  swatch: string;
};

export type DemoCommerceMetadata = {
  mode: "local-demo";
  sku: string;
  currency: "USD";
  unitAmount: number;
  displayPrice: string;
  availabilityLabel: string;
  ctaLabel: string;
  disclosure: string;
};

export type TourProduct = {
  id: FlagshipProductId;
  eyebrow: string;
  name: string;
  description: string;
  details: readonly string[];
  finishes: readonly ProductFinish[];
  defaultFinishId: string;
  commerce: DemoCommerceMetadata;
};

export type FlagshipTour = {
  id: "astra-flagship";
  eyebrow: string;
  title: string;
  description: string;
  venueLabel: string;
  initialSceneId: FlagshipSceneId;
  map: {
    label: string;
    description: string;
    aspectRatio: number;
  };
  scenes: readonly TourScene[];
  products: readonly TourProduct[];
};
