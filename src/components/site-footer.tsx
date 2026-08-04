import { ArrowUpRight } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";

export function SiteFooter() {
  return (
    <footer className="site-footer section-shell">
      <div className="site-footer__top">
        <div className="site-footer__identity">
          <a href="#top" aria-label="Astra3D home">
            <BrandMark />
          </a>
          <p>
            Immersive spaces designed to turn attention into meaningful action.
          </p>
        </div>

        <div className="site-footer__links">
          <div>
            <strong>Explore</strong>
            <a href="#platform">Platform</a>
            <a href="#experiences">Experiences</a>
            <a href="#workflow">Workflow</a>
          </div>
          <div>
            <strong>Connect</strong>
            <a href="#contact">Book a demo</a>
            <a
              href="https://www.instagram.com/astra3d.official/"
              target="_blank"
              rel="noreferrer"
            >
              Instagram <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>

      <div className="site-footer__bottom">
        <span>© {new Date().getFullYear()} Astra3D</span>
        <span>Designed for a world without walls.</span>
        <a
          href="https://www.instagram.com/astra3d.official/"
          target="_blank"
          rel="noreferrer"
          aria-label="Astra3D on Instagram"
        >
          <InstagramIcon />
        </a>
      </div>
    </footer>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17.4" cy="6.7" r="1" fill="currentColor" />
    </svg>
  );
}
