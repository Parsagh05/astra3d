import { CapabilityRail } from "@/components/capability-rail";
import { Hero } from "@/components/hero";
import { PlatformSections } from "@/components/platform";
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
        <PlatformSections />

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
