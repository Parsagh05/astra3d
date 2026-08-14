import { ArrowUpRight, Box, Camera, Orbit } from "lucide-react";
import Link from "next/link";
import { TourTrigger } from "@/components/tour";
import { HeroCanvas } from "./hero-canvas";

export function Hero() {
  return (
    <section className="hero section-shell" aria-labelledby="hero-title">
      <div className="hero__content">
        <p className="eyebrow">
          <span className="eyebrow__pulse" aria-hidden="true" />
          Spatial commerce, without the friction
        </p>
        <h1 id="hero-title">
          Build worlds
          <span>people can step into.</span>
        </h1>
        <p className="hero__lede">
          Capture a room with the phone you already own, assemble a private
          360° preview, and turn real spaces into experiences people can enter.
        </p>
        <div className="hero__actions">
          <Link className="button" href="/studio/">
            Create your 360
            <ArrowUpRight aria-hidden="true" />
          </Link>
          <TourTrigger className="button button--ghost">
            Enter live tour
            <Camera aria-hidden="true" />
          </TourTrigger>
        </div>
        <div className="hero__signal" aria-label="Platform availability">
          <span>
            <Box aria-hidden="true" /> Phone-to-360 capture lab
          </span>
          <span>
            <Orbit aria-hidden="true" /> Web · Mobile · Tablet
          </span>
        </div>
      </div>

      <div className="hero__visual" aria-hidden="true">
        <div className="hero-portal glass-panel">
          <div className="hero-portal__grid" />
          <HeroCanvas />
          <div className="hero-portal__orbit hero-portal__orbit--outer" />
          <div className="hero-portal__orbit hero-portal__orbit--inner" />
          <div className="hero-portal__core">
            <span />
            <span />
            <span />
          </div>
          <div className="hero-portal__label hero-portal__label--top">
            LIVE SCENE <i />
          </div>
          <div className="hero-portal__label hero-portal__label--bottom">
            01 / RETAIL
          </div>
        </div>
      </div>
    </section>
  );
}
