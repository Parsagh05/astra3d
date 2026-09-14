import type { Metadata } from "next";

import { TestMaker } from "@/components/test-maker";

export const metadata: Metadata = {
  title: "Test Maker",
  description: "Create new test cases by capturing images with the Astra3D guidance system.",
};

export default function TestMakerPage() {
  return <TestMaker />;
}
