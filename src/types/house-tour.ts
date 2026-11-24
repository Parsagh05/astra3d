/**
 * A house tour: 360° room panoramas (studio projects) linked by arrows, so a
 * visitor jumps from spot to spot the way Street View or GeoGuessr works.
 */

/** An arrow in one spot's panorama that moves the visitor to another spot. */
export type HouseTourLink = {
  id: string;
  targetSpotId: string;
  /** Where the arrow sits in this panorama, degrees (positive yaw turns right, pitch up). */
  yaw: number;
  pitch: number;
};

/** One standing point: a saved 360° project plus its arrows. */
export type HouseTourSpot = {
  id: string;
  /** The studio project whose panorama this spot shows. */
  projectId: string;
  name: string;
  /** Which way the visitor faces when the tour opens here. */
  startYaw: number;
  links: HouseTourLink[];
};

export type HouseTour = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  startSpotId: string;
  spots: HouseTourSpot[];
};

/** What the editor sends back on save: everything except server-owned fields. */
export type HouseTourInput = Pick<HouseTour, "name" | "startSpotId" | "spots">;
