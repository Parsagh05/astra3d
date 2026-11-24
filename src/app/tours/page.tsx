import type { Metadata } from "next";

import { HouseTourLibrary } from "@/components/house-tour/house-tour-library";

export const metadata: Metadata = {
  title: "House Tours",
  description: "Link 360° room photos with arrows and walk through the house, Street View style.",
  alternates: { canonical: "/tours" },
};

export default function ToursPage() {
  return <HouseTourLibrary />;
}
