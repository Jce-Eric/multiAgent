import path from "node:path";
import type { AgentEngine, AgentRunContext } from "./types.js";
import { abortableDelay } from "../utils.js";

const marker = (prompt: string, name: string): string | undefined => {
  const match = prompt.match(new RegExp(`\\[\\[${name}:(.*?)\\]\\]`, "s"));
  return match?.[1]?.trim();
};

export class ReferenceEngine implements AgentEngine {
  readonly capabilities = {
    protocol: "reference",
    protocolVersion: "1",
    nativeSessions: false,
    questions: true,
    permissions: true,
    cancellation: true,
  } as const;

  constructor(
    public readonly name: string,
    private readonly displayName: string,
  ) {}

  async generate(prompt: string, context: AgentRunContext): Promise<string> {
    context.emitEvent("reference.run", { engine: this.name, directory: context.directory });
    const question = marker(prompt, "ask");
    const permission = marker(prompt, "permission");
    const errorMessage = marker(prompt, "error");
    const slowValue = marker(prompt, "slow");

    if (errorMessage) {
      throw new Error(errorMessage);
    }

    const parts: string[] = [`${this.displayName}: `];
    context.emitDelta(parts[0]);

    if (slowValue) {
      const milliseconds = Math.max(10, Math.min(Number(slowValue) || 2_000, 30_000));
      await abortableDelay(milliseconds, context.signal);
    }

    if (question) {
      const response = await context.askQuestion({ question });
      const text = `question answered with "${response.answer}". `;
      parts.push(text);
      context.emitDelta(text);
    }

    if (permission) {
      const response = await context.requestPermission({
        operation: permission,
        reason: `The ${this.displayName} engine requested this operation`,
      });
      const text = `permission ${response.decision} for "${permission}". `;
      parts.push(text);
      context.emitDelta(text);
    }

    const cleanPrompt = prompt.replace(/\[\[(ask|permission|slow|error):.*?\]\]/gs, "").trim();
    const body = prompt.includes("[[pwd]]")
      ? `working directory is ${path.resolve(context.directory)}`
      : cleanPrompt || "done";

    for (const chunk of body.match(/.{1,24}/gs) ?? [body]) {
      await abortableDelay(5, context.signal);
      parts.push(chunk);
      context.emitDelta(chunk);
    }

    return parts.join("");
  }
}
