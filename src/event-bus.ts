import type { GatewayEvent, GatewayEventType } from "./types.js";
import { now } from "./utils.js";

export type EventListener = (event: GatewayEvent) => void;

export class EventBus {
  private sequence = 0;
  private readonly history: GatewayEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly historyLimit = 1_000) {}

  publish(
    type: GatewayEventType,
    data: unknown,
    context: { sessionId?: string; runId?: string } = {},
  ): GatewayEvent {
    const event: GatewayEvent = {
      id: ++this.sequence,
      type,
      timestamp: now(),
      ...context,
      data,
    };

    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }

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
    return this.history.filter(
      (event) => event.id > lastEventId && (!sessionId || event.sessionId === sessionId),
    );
  }
}
