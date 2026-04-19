// ---------------------------------------------------------------------------
// Pop-out Run Detail Page (CDD-gui §9)
//
// Standalone page for /run/:runId — renders RunDetail without sidebar nav.
// Gets its own daemon connection, WS, and stores (separate JS context).
// ---------------------------------------------------------------------------

import { useParams } from 'react-router-dom';
import { PopoutLayout } from '../components/shared/PopoutLayout';
import { RunDetail } from '../components/run/RunDetail';
import type { WebSocketManager } from '../api/ws';

function useWsRef(): WebSocketManager | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).__vibeWsRef ?? null;
}

export function PopoutRunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const ws = useWsRef();

  if (!runId) {
    return (
      <PopoutLayout title="Run Detail">
        <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
          No run ID provided
        </div>
      </PopoutLayout>
    );
  }

  return (
    <PopoutLayout title={`Run ${runId.slice(0, 8)}`}>
      <RunDetail runId={runId} ws={ws} />
    </PopoutLayout>
  );
}
