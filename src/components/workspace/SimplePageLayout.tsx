"use client";

import { AppHeader } from "@/components/layout/AppHeader";
import { StatusBar } from "@/components/layout/StatusBar";

interface SimplePageLayoutProps {
  children: React.ReactNode;
}

export function SimplePageLayout({ children }: SimplePageLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <AppHeader />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-4">
          {children}
        </div>
      </main>
      <StatusBar />
    </div>
  );
}
