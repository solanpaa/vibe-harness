// ---------------------------------------------------------------------------
// Pop-Out Button (CDD-gui §9.1)
//
// Small icon button that opens the given route in a new OS window.
// ---------------------------------------------------------------------------

import { openPopoutWindow } from '../../lib/popout';

interface PopOutButtonProps {
  /** Route to open in the new window (e.g. "/run/abc123"). */
  route: string;
  /** Window title. */
  title: string;
  /** Tooltip text. */
  tooltip?: string;
}

export function PopOutButton({ route, title, tooltip = 'Open in new window' }: PopOutButtonProps) {
  return (
    <button
      onClick={() => openPopoutWindow(route, title)}
      title={tooltip}
      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
      aria-label={tooltip}
    >
      {/* External link icon (SVG) */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </button>
  );
}
