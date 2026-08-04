import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import React from "react";
import { afterEach, vi } from "vitest";

const mediaQueryMatches = new Map<string, boolean>();

export function setMediaQueryMatches(query: string, matches: boolean) {
  mediaQueryMatches.set(query, matches);
}

export function resetMediaQueryMatches() {
  mediaQueryMatches.clear();
}

vi.mock("next/image", () => ({
  default: ({
    fill: _fill,
    priority: _priority,
    src,
    ...props
  }: {
    fill?: boolean;
    priority?: boolean;
    src: string | { src: string };
    alt: string;
    [key: string]: unknown;
  }) => {
    void _fill;
    void _priority;

    return React.createElement("img", {
      ...props,
      src: typeof src === "string" ? src : src.src,
    });
  },
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicSceneStub() {
      return React.createElement("canvas", { "data-testid": "hero-scene" });
    },
}));

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: vi.fn((query: string): MediaQueryList => ({
    matches: mediaQueryMatches.get(query) ?? false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })),
});

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: vi.fn(() => ({})),
});

Object.defineProperty(window, "WebGLRenderingContext", {
  configurable: true,
  value: class WebGLRenderingContextStub {},
});

class IntersectionObserverStub implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  disconnect = vi.fn();
  observe = vi.fn((target: Element) => {
    this.callback(
      [
        {
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRatio: 1,
          intersectionRect: target.getBoundingClientRect(),
          isIntersecting: true,
          rootBounds: null,
          target,
          time: performance.now(),
        },
      ],
      this,
    );
  });
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();
}

class ResizeObserverStub implements ResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
}

vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

afterEach(() => {
  cleanup();
  resetMediaQueryMatches();
  document.body.style.overflow = "";
  window.location.hash = "";
});
