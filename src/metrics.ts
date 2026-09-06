import type { GatewayService } from "./gateway-service.js";
import type { GatewayEvent } from "./types.js";

export class GatewayMetrics {
  private readonly requests = new Map<string, number>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly service: GatewayService) {
    service.events.subscribe((event) => this.observeEvent(event));
  }

  observeRequest(method: string, route: string, status: number): void {
    this.increment(this.requests, `${method}\u0000${route}\u0000${status}`);
  }

  render(): string {
    const stats = this.service.stats();
    const lines = [
      "# HELP multi_agent_gateway_sessions Current logical sessions.",
      "# TYPE multi_agent_gateway_sessions gauge",
      `multi_agent_gateway_sessions ${stats.sessions}`,
      "# HELP multi_agent_gateway_active_runs Current active generations.",
      "# TYPE multi_agent_gateway_active_runs gauge",
      `multi_agent_gateway_active_runs ${stats.activeRuns}`,
      "# HELP multi_agent_gateway_ready Whether the gateway is ready.",
      "# TYPE multi_agent_gateway_ready gauge",
      `multi_agent_gateway_ready ${this.service.isReady() ? 1 : 0}`,
      "# HELP multi_agent_gateway_http_requests_total HTTP requests by method, route, and status.",
      "# TYPE multi_agent_gateway_http_requests_total counter",
    ];
    for (const [key, value] of this.requests) {
      const [method, route, status] = key.split("\u0000");
      lines.push(
        `multi_agent_gateway_http_requests_total{method="${label(method)}",route="${label(route)}",status="${label(status)}"} ${value}`,
      );
    }
    lines.push(
      "# HELP multi_agent_gateway_generations_total Generations by terminal outcome.",
      "# TYPE multi_agent_gateway_generations_total counter",
    );
    for (const [outcome, value] of this.generations) {
      lines.push(`multi_agent_gateway_generations_total{outcome="${label(outcome)}"} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private observeEvent(event: GatewayEvent): void {
    const outcome = event.type.startsWith("generation.")
      ? event.type.slice("generation.".length)
      : undefined;
    if (outcome === "completed" || outcome === "failed" || outcome === "stopped") {
      this.increment(this.generations, outcome);
    }
  }

  private increment(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}
