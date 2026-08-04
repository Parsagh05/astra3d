import { ArrowDownRight, ArrowUpRight, Box, Orbit } from "lucide-react";
import { DemoTrigger } from "@/components/demo-request";
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
          Create, publish, and measure immersive stores and spaces that move
          seamlessly across web, mobile, and VR.
        </p>
        <div className="hero__actions">
          <a className="button" href="#experiences">
            Explore experiences
            <ArrowDownRight aria-hidden="true" />
          </a>
          <DemoTrigger className="button button--ghost">
            Book a demo
            <ArrowUpRight aria-hidden="true" />
          </DemoTrigger>
        </div>
        <div className="hero__signal" aria-label="Platform availability">
          <span>
            <Box aria-hidden="true" /> No-code builder
          </span>
          <span>
            <Orbit aria-hidden="true" /> Web · Mobile · VR
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
