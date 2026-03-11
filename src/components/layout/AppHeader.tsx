"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Terminal,
  FolderGit2,
  KeyRound,
  Settings,
  Workflow,
  ListTodo,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function NavTab({
  href,
  icon: Icon,
  label,
  pathname,
  exact,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  pathname: string;
  exact?: boolean;
}) {
  const isActive = exact ? pathname === href : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="flex h-12 shrink-0 items-center border-b bg-card px-4 shadow-sm">
      <Link
        href="/"
        className="flex items-center gap-2 font-bold text-sm shrink-0"
      >
        <Terminal className="h-5 w-5" />
        Vibe Harness
      </Link>
      <nav className="ml-6 flex items-center gap-1">
        <NavTab
          href="/"
          icon={ListTodo}
          label="Tasks"
          pathname={pathname}
          exact
        />
        <NavTab
          href="/projects"
          icon={FolderGit2}
          label="Projects"
          pathname={pathname}
        />
        <NavTab
          href="/workflows"
          icon={Workflow}
          label="Workflows"
          pathname={pathname}
        />
        <NavTab
          href="/credentials"
          icon={KeyRound}
          label="Credentials"
          pathname={pathname}
        />
      </nav>
      <div className="ml-auto">
        <Link href="/settings">
          <Button variant="ghost" size="icon" aria-label="Settings">
            <Settings className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </header>
  );
}
