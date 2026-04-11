// ---------------------------------------------------------------------------
// useWebSocketBridge — routes WS events to Zustand stores (CDD-gui §5.3)
//
// Subscribes to the WebSocketManager's onMessage stream and dispatches
// run_status / stage_status / review_created / notification events to the
// workspace store so the UI updates in real time.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import type { WebSocketManager } from '../api/ws';
import type { ServerMessage } from '@vibe-harness/shared';
import { useWorkspaceStore, type AppNotification } from '../stores/workspace';

let notifCounter = 0;

export function useWebSocketBridge(ws: WebSocketManager | null): void {
  const updateRun = useWorkspaceStore((s) => s.updateRun);
  const addNotification = useWorkspaceStore((s) => s.addNotification);
  const addPendingReview = useWorkspaceStore((s) => s.addPendingReview);

  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'run_status': {
          updateRun(msg.runId, {
            status: msg.status,
            currentStage: msg.currentStage,
            title: msg.title,
          });
          break;
        }

        case 'stage_status': {
          // Stage changes may affect the run's currentStage display
          updateRun(msg.runId, { currentStage: msg.stageName });
          break;
        }

        case 'review_created': {
          addPendingReview(msg.runId);
          const notif: AppNotification = {
            id: `review-${msg.reviewId}-${++notifCounter}`,
            level: 'info',
            message: `Review ready for ${msg.stageName ?? 'run'} (round ${msg.round})`,
            runId: msg.runId,
            timestamp: Date.now(),
          };
          addNotification(notif);
          break;
        }

        case 'notification': {
          const notif: AppNotification = {
            id: `notif-${++notifCounter}`,
            level: msg.level,
            message: msg.message,
            runId: msg.runId,
            timestamp: Date.now(),
          };
          addNotification(notif);
          break;
        }
      }
    });

    return unsub;
  }, [ws, updateRun, addNotification, addPendingReview]);
}
