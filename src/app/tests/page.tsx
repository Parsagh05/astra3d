import type { Metadata } from "next";

import { TestRunner } from "@/components/test-runner";

export const metadata: Metadata = {
  title: "Test Runner",
  description: "Run static panorama tests against the Astra3D pipeline.",
};

export default function TestsPage() {
  return <TestRunner />;
}
