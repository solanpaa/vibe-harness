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
  Search,
  Sun,
  Moon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

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
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
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
  const { theme, setTheme } = useTheme();

  return (
    <header className="flex h-10 shrink-0 items-center border-b bg-card px-3 shadow-sm">
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
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={() =>
            document.dispatchEvent(new Event("open-command-palette"))
          }
          className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
        >
          <Search className="h-3 w-3" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="pointer-events-none rounded border bg-muted px-1 text-[10px] font-mono">
            ⌘K
          </kbd>
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="h-8 w-8"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Link href="/settings">
          <Button variant="ghost" size="icon" aria-label="Settings" className="h-8 w-8">
            <Settings className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </header>
  );
}
