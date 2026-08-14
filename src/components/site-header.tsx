"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { DemoTrigger } from "@/components/demo-request";

const navigation = [
  { href: "/studio/", label: "Create 360" },
  { href: "#platform", label: "Platform" },
  { href: "#experiences", label: "Experiences" },
  { href: "#workflow", label: "Workflow" },
  { href: "#contact", label: "Contact" },
];

export function SiteHeader() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen]);

  const closeMenu = () => setIsOpen(false);

  return (
    <header className="site-header">
      <div className="site-header__inner glass-panel">
        <a className="site-header__brand" href="#top" onClick={closeMenu}>
          <BrandMark />
        </a>

        <nav className="site-header__desktop-nav" aria-label="Primary navigation">
          {navigation.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <Link className="button button--compact site-header__cta" href="/studio/">
          Scan a room
        </Link>

        <button
          className="site-header__menu-button"
          type="button"
          aria-expanded={isOpen}
          aria-controls="mobile-navigation"
          aria-label={isOpen ? "Close navigation" : "Open navigation"}
          onClick={() => setIsOpen((value) => !value)}
        >
          {isOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </div>

      <nav
        className="site-header__mobile-nav glass-panel"
        id="mobile-navigation"
        aria-label="Mobile navigation"
        data-open={isOpen}
      >
        {navigation.map((item) => (
          <Link key={item.href} href={item.href} onClick={closeMenu}>
            {item.label}
          </Link>
        ))}
        <Link className="button" href="/studio/" onClick={closeMenu}>
          Scan a room
        </Link>
        <DemoTrigger className="button button--ghost" onOpen={closeMenu}>
          Book a demo
        </DemoTrigger>
      </nav>
    </header>
  );
}
