import type { Metadata } from "next";

import { ScanView } from "@/components/scan/scan-view";

export const metadata: Metadata = {
  title: "3D Scan",
  robots: { index: false },
};

export default async function ScanViewPage({ params }: { params: Promise<{ scanId: string }> }) {
  const { scanId } = await params;
  return <ScanView scanId={scanId} />;
}
