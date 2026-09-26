import type { Metadata } from "next";

import { ScanStudio } from "@/components/scan/scan-studio";

export const metadata: Metadata = {
  title: "3D Room Scan",
  description: "Film a walk around a room and turn it into a Gaussian splat scene you can walk through.",
  alternates: { canonical: "/scan" },
};

export default function ScanPage() {
  return <ScanStudio />;
}
