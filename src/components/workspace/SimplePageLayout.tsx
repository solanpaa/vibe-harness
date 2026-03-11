"use client";

import Link from "next/link";
import { ArrowLeft, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfigMenu } from "./ConfigMenu";

interface SimplePageLayoutProps {
  children: React.ReactNode;
}

export function SimplePageLayout({ children }: SimplePageLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Top bar — matches WorkspaceLayout */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <Link href="/" className="flex items-center gap-2 font-bold text-sm">
          <Terminal className="h-5 w-5" />
          Vibe Harness
        </Link>
        <ConfigMenu />
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-6">
          <div className="mb-4">
            <Button variant="ghost" size="sm" render={<Link href="/" />}>
              <ArrowLeft className="h-4 w-4" />
              Back to Workspace
            </Button>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
