// ---------------------------------------------------------------------------
// WebSocket Handler (CDD-api §12, §14.4)
//
// Exports an H3 WebSocket handler that uses crossws (via Nitro) for the
// /ws endpoint. Handles auth, subscribe/unsubscribe, and ping/pong.
// ---------------------------------------------------------------------------

import { defineWebSocketHandler } from 'h3';
import type { ClientMessage, ServerMessage } from '@vibe-harness/shared';
import { getOrCreateToken } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import * as streamingService from '../services/streaming-service.js';

const log = logger.child({ module: 'ws' });
const VERSION = process.env.VERSION ?? '0.0.0';

export default defineWebSocketHandler({
  upgrade(request) {
    // Authenticate via query parameter (CDD-api §13.3)
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const expectedToken = getOrCreateToken();

    if (token !== expectedToken) {
      log.warn('WebSocket upgrade rejected: invalid token');
      throw new Response('Unauthorized', { status: 401 });
    }

    // Pass peer context for identification
    return {
      context: { authenticatedAt: Date.now() },
    };
  },

  open(peer) {
    const clientId = peer.id;
    log.info({ clientId }, 'WebSocket client connected');

    // Register client with streaming service
    const send = (msg: ServerMessage) => {
      try {
        peer.send(JSON.stringify(msg));
      } catch {
        log.warn({ clientId }, 'Failed to send WS message');
      }
    };

    streamingService.addClient(clientId, send);

    // Send connected acknowledgement (CDD-api §12.1)
    send({ type: 'connected', serverVersion: VERSION });
  },

  message(peer, message) {
    const clientId = peer.id;

    try {
      const msg: ClientMessage = JSON.parse(message.text());

      switch (msg.type) {
        case 'subscribe':
          streamingService.subscribe(clientId, msg.runId, msg.lastSeq);
          break;

        case 'unsubscribe':
          streamingService.unsubscribe(clientId, msg.runId);
          break;

        case 'ping':
          peer.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
          break;

        default:
          log.debug({ clientId, msg }, 'Unknown client message type');
      }
    } catch {
      log.debug({ clientId }, 'Malformed WebSocket message');
    }
  },

  close(peer) {
    const clientId = peer.id;
    streamingService.removeClient(clientId);
    log.info({ clientId }, 'WebSocket client disconnected');
  },

  error(peer, error) {
    log.error({ clientId: peer.id, error: error.message }, 'WebSocket error');
  },
});
