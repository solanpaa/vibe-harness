// ---------------------------------------------------------------------------
// Popout Layout (CDD-gui §9.1)
//
// Minimal layout for pop-out windows: no sidebar nav, just a thin header
// with DaemonStatus and the content. Each pop-out window has its own
// Zustand stores and WS connection (separate JS context).
// ---------------------------------------------------------------------------

import { DaemonStatus } from './DaemonStatus';

interface PopoutLayoutProps {
  title: string;
  children: React.ReactNode;
}

export function PopoutLayout({ title, children }: PopoutLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100">
      {/* Thin header */}
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm px-4 py-1.5">
        <span className="text-sm font-medium text-zinc-300 truncate">
          {title}
        </span>
        <DaemonStatus />
      </header>

      {/* Content */}
      <main className="flex-1 overflow-hidden p-4">
        {children}
      </main>
    </div>
  );
}
