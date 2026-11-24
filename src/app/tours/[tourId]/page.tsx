import type { Metadata } from "next";

import { HouseTourViewer } from "@/components/house-tour/house-tour-viewer";

export const metadata: Metadata = {
  title: "House Tour",
  robots: { index: false },
};

export default async function TourPage({
  params,
  searchParams,
}: {
  params: Promise<{ tourId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tourId } = await params;
  const { edit } = await searchParams;
  return <HouseTourViewer key={tourId} tourId={tourId} initialEdit={edit === "1"} />;
}
