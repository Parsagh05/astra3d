import type { Metadata } from "next";

import { RoomStudio } from "@/components/room-capture";

export const metadata: Metadata = {
  title: "Create a 360° Room",
  description:
    "Use guided smartphone photos to assemble and preview a private single-room 360 panorama directly in your browser.",
  alternates: { canonical: "/studio/" },
};

export default function StudioPage() {
  return <RoomStudio />;
}
