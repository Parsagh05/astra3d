"use client";

import type { ReactNode } from "react";

import { useDemoRequest } from "./demo-request-provider";

type DemoTriggerProps = {
  children: ReactNode;
  className?: string;
  onOpen?: () => void;
};

export function DemoTrigger({ children, className, onOpen }: DemoTriggerProps) {
  const { openDemoRequest } = useDemoRequest();

  return (
    <button
      className={className}
      type="button"
      onClick={() => {
        onOpen?.();
        openDemoRequest();
      }}
    >
      {children}
    </button>
  );
}
