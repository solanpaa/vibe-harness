"use client";

import Link from "next/link";
import { FolderGit2, KeyRound, Settings, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const menuItems = [
  { label: "Projects", href: "/projects", icon: FolderGit2 },
  { label: "Credentials", href: "/credentials", icon: KeyRound },
  { label: "Workflows", href: "/workflows", icon: Workflow },
] as const;

export function ConfigMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Configuration menu">
            <Settings className="h-4 w-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4}>
        {menuItems.map((item) => (
          <DropdownMenuItem
            key={item.href}
            render={
              <Link href={item.href}>
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            }
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          render={
            <Link href="/settings">
              <Settings className="h-4 w-4" />
              Settings
            </Link>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
