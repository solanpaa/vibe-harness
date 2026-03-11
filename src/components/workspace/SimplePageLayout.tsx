"use client";

import { AppHeader } from "@/components/layout/AppHeader";

interface SimplePageLayoutProps {
  children: React.ReactNode;
}

export function SimplePageLayout({ children }: SimplePageLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <AppHeader />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
