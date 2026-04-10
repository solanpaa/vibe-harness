"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import {
  ListTodo,
  FolderGit2,
  Workflow,
  KeyRound,
  Settings,
  Plus,
} from "lucide-react";

interface CommandPaletteProps {
  onNewTask?: () => void;
}

export function CommandPalette({ onNewTask }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function handleOpen() {
      setOpen(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("open-command-palette", handleOpen);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("open-command-palette", handleOpen);
    };
  }, []);

  const runCommand = useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {onNewTask && (
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => runCommand(onNewTask)}>
              <Plus className="mr-2 h-4 w-4" />
              New Task
              <CommandShortcut>⌘N</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => runCommand(() => router.push("/"))}>
            <ListTodo className="mr-2 h-4 w-4" />
            Tasks
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/projects"))}
          >
            <FolderGit2 className="mr-2 h-4 w-4" />
            Projects
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/workflows"))}
          >
            <Workflow className="mr-2 h-4 w-4" />
            Workflows
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/credentials"))}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            Credentials
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/settings"))}
          >
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
