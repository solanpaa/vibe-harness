import { describe, it, expect, vi, beforeEach } from "vitest";
import { useStreamingStore } from "../../stores/streaming";
import type { RunOutputMessage, ServerMessage } from "@vibe-harness/shared";
import type { WebSocketManager } from "../../api/ws";

function getState() {
  return useStreamingStore.getState();
}

function makeRunOutput(runId: string, seq: number): RunOutputMessage {
  return {
    type: "run_output",
    runId,
    seq,
    stageName: "implement",
    round: 1,
    data: {
      role: "assistant",
      content: `message ${seq}`,
      eventType: "agent_message",
      timestamp: new Date().toISOString(),
    },
  };
}

function makeMockWs(): WebSocketManager {
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as unknown as WebSocketManager;
}

describe("Streaming store", () => {
  beforeEach(() => {
    useStreamingStore.setState({
      buffers: new Map(),
      wsState: "closed",
      resyncRequired: new Set(),
    });
  });

  describe("handleMessage — run_output", () => {
    it("appends event to buffer for the run", () => {
      const msg = makeRunOutput("run-1", 0);
      getState().handleMessage(msg);

      const buf = getState().buffers.get("run-1");
      expect(buf).toBeDefined();
      expect(buf!.events).toHaveLength(1);
      expect(buf!.events[0].seq).toBe(0);
      expect(buf!.lastSeq).toBe(0);
    });

    it("creates buffer if run not seen before", () => {
      expect(getState().buffers.has("run-new")).toBe(false);

      getState().handleMessage(makeRunOutput("run-new", 0));

      expect(getState().buffers.has("run-new")).toBe(true);
    });

    it("ignores duplicate seq (dedup)", () => {
      getState().handleMessage(makeRunOutput("run-1", 0));
      getState().handleMessage(makeRunOutput("run-1", 1));
      // Send seq 1 again — should be ignored
      getState().handleMessage(makeRunOutput("run-1", 1));

      expect(getState().buffers.get("run-1")!.events).toHaveLength(2);
      expect(getState().buffers.get("run-1")!.lastSeq).toBe(1);
    });

    it("ignores out-of-order seq", () => {
      getState().handleMessage(makeRunOutput("run-1", 0));
      getState().handleMessage(makeRunOutput("run-1", 5));
      // Send earlier seq — should be ignored
      getState().handleMessage(makeRunOutput("run-1", 3));

      expect(getState().buffers.get("run-1")!.events).toHaveLength(2);
      expect(getState().buffers.get("run-1")!.lastSeq).toBe(5);
    });

    it("trims buffer when exceeding max size (5000)", () => {
      // Pre-populate buffer close to limit
      const events: RunOutputMessage[] = [];
      for (let i = 0; i < 5000; i++) {
        events.push(makeRunOutput("run-1", i));
      }
      useStreamingStore.setState({
        buffers: new Map([["run-1", { events, lastSeq: 4999 }]]),
      });

      // Add one more — should trigger trim
      getState().handleMessage(makeRunOutput("run-1", 5000));

      const buf = getState().buffers.get("run-1")!;
      expect(buf.events.length).toBeLessThanOrEqual(5000);
      expect(buf.lastSeq).toBe(5000);
    });
  });

  describe("handleMessage — resync_required", () => {
    it("sets resync flag for the run", () => {
      const msg: ServerMessage = {
        type: "resync_required",
        runId: "run-1",
        reason: "buffer overflow",
      };
      getState().handleMessage(msg);

      expect(getState().resyncRequired.has("run-1")).toBe(true);
    });
  });

  describe("subscribe / unsubscribe", () => {
    it("subscribe creates buffer and sends ws subscribe", () => {
      const ws = makeMockWs();
      getState().subscribe("run-1", ws);

      expect(getState().buffers.has("run-1")).toBe(true);
      expect(ws.subscribe).toHaveBeenCalledWith("run-1", undefined);
    });

    it("subscribe with existing buffer sends lastSeq", () => {
      // Pre-populate buffer
      getState().handleMessage(makeRunOutput("run-1", 0));
      getState().handleMessage(makeRunOutput("run-1", 5));

      const ws = makeMockWs();
      getState().subscribe("run-1", ws);

      expect(ws.subscribe).toHaveBeenCalledWith("run-1", 5);
    });

    it("unsubscribe sends ws unsubscribe", () => {
      const ws = makeMockWs();
      getState().unsubscribe("run-1", ws);

      expect(ws.unsubscribe).toHaveBeenCalledWith("run-1");
    });
  });

  describe("clearResync", () => {
    it("removes run from resyncRequired set", () => {
      useStreamingStore.setState({
        resyncRequired: new Set(["run-1", "run-2"]),
      });

      getState().clearResync("run-1");

      expect(getState().resyncRequired.has("run-1")).toBe(false);
      expect(getState().resyncRequired.has("run-2")).toBe(true);
    });
  });

  describe("clearBuffer", () => {
    it("removes buffer for the run", () => {
      getState().handleMessage(makeRunOutput("run-1", 0));
      expect(getState().buffers.has("run-1")).toBe(true);

      getState().clearBuffer("run-1");
      expect(getState().buffers.has("run-1")).toBe(false);
    });
  });

  describe("setWsState", () => {
    it("updates wsState", () => {
      getState().setWsState("open");
      expect(getState().wsState).toBe("open");

      getState().setWsState("reconnecting");
      expect(getState().wsState).toBe("reconnecting");
    });
  });
});
