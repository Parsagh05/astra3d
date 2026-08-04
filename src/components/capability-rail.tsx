import { BarChart3, Braces, MonitorSmartphone } from "lucide-react";

const capabilities = [
  {
    icon: Braces,
    label: "No code",
    copy: "Compose rich spaces visually.",
  },
  {
    icon: MonitorSmartphone,
    label: "Any screen",
    copy: "Publish once, meet every device.",
  },
  {
    icon: BarChart3,
    label: "Live insight",
    copy: "See what earns attention.",
  },
];

export function CapabilityRail() {
  return (
    <aside className="capability-rail section-shell" aria-label="Platform highlights">
      {capabilities.map(({ icon: Icon, label, copy }) => (
        <div className="capability-rail__item" key={label}>
          <span className="capability-rail__icon">
            <Icon aria-hidden="true" />
          </span>
          <span>
            <strong>{label}</strong>
            <small>{copy}</small>
          </span>
        </div>
      ))}
    </aside>
  );
}
