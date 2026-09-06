import type { GatewayEvent, GatewayEventType } from "./types.js";
import { MemoryEventRepository, type EventRepository } from "./event-store.js";
import { now } from "./utils.js";

export type EventListener = (event: GatewayEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

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

    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
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
}
