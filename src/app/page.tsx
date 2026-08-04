import { CapabilityRail } from "@/components/capability-rail";
import { Hero } from "@/components/hero";
import { SectionHeading } from "@/components/section-heading";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function HomePage() {
  return (
    <div className="site-frame">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="ambient-grid" aria-hidden="true" />
      <SiteHeader />
      <main id="main-content">
        <Hero />
        <CapabilityRail />

        <section className="foundation-section section-shell" id="platform">
          <SectionHeading
            eyebrow="One spatial platform"
            title="Built for presence, not just page views."
            copy="Astra3D brings creation, commerce, and insight into one fluid system—ready for richer product stories and deeper exploration."
          />
          <div className="foundation-section__preview glass-panel">
            <span>PLATFORM PREVIEW</span>
            <div />
          </div>
        </section>

        <section className="anchor-section" id="experiences" aria-label="Experiences" />
        <section className="anchor-section" id="workflow" aria-label="Workflow" />

        <section className="closing-shell section-shell" id="contact">
          <p className="eyebrow">The next dimension is ready</p>
          <h2>Your next storefront doesn&apos;t need walls.</h2>
          <a className="button" href="mailto:hello@astra3d.com">
            Start a conversation
            <ArrowIcon />
          </a>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h12M11 5l5 5-5 5" />
    </svg>
  );
}
