"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

import { DemoRequestModal } from "./demo-request-modal";

type DemoRequestContextValue = {
  openDemoRequest: () => void;
};

const DemoRequestContext = createContext<DemoRequestContextValue | null>(null);

export function DemoRequestProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const openDemoRequest = useCallback(() => setIsOpen(true), []);
  const closeDemoRequest = useCallback(() => setIsOpen(false), []);

  return (
    <DemoRequestContext.Provider value={{ openDemoRequest }}>
      {children}
      <DemoRequestModal open={isOpen} onClose={closeDemoRequest} />
    </DemoRequestContext.Provider>
  );
}

export function useDemoRequest() {
  const context = useContext(DemoRequestContext);

  if (!context) {
    throw new Error("useDemoRequest must be used inside DemoRequestProvider");
  }

  return context;
}
