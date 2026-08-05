"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { useTour } from "./tour-provider";

type TourTriggerProps = Omit<ComponentPropsWithoutRef<"button">, "onClick"> & {
  children: ReactNode;
  sceneId?: string;
};

export function TourTrigger({
  children,
  sceneId,
  type = "button",
  ...buttonProps
}: TourTriggerProps) {
  const { openTour } = useTour();

  return (
    <button
      {...buttonProps}
      type={type}
      onClick={() => openTour({ sceneId })}
    >
      {children}
    </button>
  );
}
