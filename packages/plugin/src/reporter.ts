/**
 * Flow-A2A — Batch Reporter
 *
 * Buffers TelemetryRecords and flushes them via WebSocket at a configurable interval.
 * If the connection is down, records are buffered and sent on reconnect.
 */

import type { TelemetryRecord } from "@flow-a2a/shared";
import type { RelayClient } from "./relay-client.js";

const MAX_BUFFER_SIZE = 10_000;

export class Reporter {
  private buffer: TelemetryRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private client: RelayClient;
  private intervalMs: number;

  constructor(client: RelayClient, intervalMs = 10_000) {
    this.client = client;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.flush(); // final flush attempt
  }

  push(record: TelemetryRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_SIZE);
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    if (!this.client.isConnected()) return; // keep buffer for later

    const batch = this.buffer.splice(0);
    this.client.sendTelemetry(batch);
  }
}
