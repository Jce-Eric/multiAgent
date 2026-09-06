import type { GatewayEvent, GatewayEventType } from "./types.js";
import { MemoryEventRepository, type EventRepository } from "./event-store.js";
import { now } from "./utils.js";

export type EventListener = (event: GatewayEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly transactionBuffers: GatewayEvent[][] = [];

  constructor(
    historyLimit = 1_000,
    private readonly repository: EventRepository = new MemoryEventRepository(historyLimit),
  ) {}

  publish(
    type: GatewayEventType,
    data: unknown,
    context: { sessionId?: string; runId?: string } = {},
  ): GatewayEvent {
    const event = this.repository.append({
      specVersion: "1.0",
      source: "multi-agent-gateway",
      type,
      timestamp: now(),
      ...context,
      data,
    });

    const buffer = this.transactionBuffers.at(-1);
    if (buffer) buffer.push(event);
    else this.notify(event);
    return event;
  }

  afterCommit<T>(operation: () => T): T {
    const buffer: GatewayEvent[] = [];
    this.transactionBuffers.push(buffer);
    try {
      const result = operation();
      this.transactionBuffers.pop();
      const parent = this.transactionBuffers.at(-1);
      if (parent) parent.push(...buffer);
      else for (const event of buffer) this.notify(event);
      return result;
    } catch (error) {
      this.transactionBuffers.pop();
      throw error;
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventsAfter(lastEventId: number, sessionId?: string): GatewayEvent[] {
    return this.repository.eventsAfter(lastEventId, sessionId);
  }

  health(): boolean {
    return this.repository.health();
  }

  close(): void {
    this.repository.close();
  }

  private notify(event: GatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Event persistence has already succeeded; one subscriber must not break the publisher.
      }
    }
  }
}
