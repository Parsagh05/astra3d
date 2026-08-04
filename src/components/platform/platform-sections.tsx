import { experiences } from "@/data/platform";

import { CapabilitiesGrid } from "./capabilities-grid";
import { ControlCenter } from "./control-center";
import { ExperienceShowcase } from "./experience-showcase";
import { WorkflowSection } from "./workflow-section";

export function PlatformSections() {
  return (
    <>
      <ExperienceShowcase experiences={experiences} />
      <WorkflowSection />
      <ControlCenter />
      <CapabilitiesGrid />
    </>
  );
}
