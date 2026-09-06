import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { GatewayError, AbortGenerationError } from "../errors.js";
import { deferred } from "../utils.js";
import type { AgentEngine, AgentRunContext } from "./types.js";

interface BridgeEvent {
  type: "delta" | "question" | "permission" | "completed" | "error";
  text?: string;
  question?: string;
  choices?: string[];
  operation?: string;
  reason?: string;
  message?: string;
}

export class ProcessBridgeEngine implements AgentEngine {
  constructor(
    public readonly name: string,
    private readonly command: string,
  ) {}

  async generate(prompt: string, context: AgentRunContext): Promise<string> {
    const child = spawn(this.command, {
      cwd: context.directory,
      env: process.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const completion = deferred<string>();
    let output = "";
    let stderr = "";
    let settled = false;
    let processing = Promise.resolve();

    const write = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        callback();
      }
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
      finish(() => completion.reject(new AbortGenerationError()));
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      processing = processing.then(async () => {
        let event: BridgeEvent;
        try {
          event = JSON.parse(line) as BridgeEvent;
        } catch {
          throw new GatewayError(502, "ENGINE_PROTOCOL_ERROR", "Engine emitted invalid JSON", {
            line,
          });
        }

        switch (event.type) {
          case "delta": {
            const text = event.text ?? "";
            output += text;
            context.emitDelta(text);
            break;
          }
          case "question": {
            if (!event.question) {
              throw new GatewayError(502, "ENGINE_PROTOCOL_ERROR", "Question text is required");
            }
            const response = await context.askQuestion({
              question: event.question,
              choices: event.choices,
            });
            write({ type: "interaction.response", interaction: "question", ...response });
            break;
          }
          case "permission": {
            if (!event.operation) {
              throw new GatewayError(502, "ENGINE_PROTOCOL_ERROR", "Permission operation is required");
            }
            const response = await context.requestPermission({
              operation: event.operation,
              reason: event.reason,
            });
            write({ type: "interaction.response", interaction: "permission", ...response });
            break;
          }
          case "completed":
            if (event.text && !output) {
              output = event.text;
            }
            finish(() => completion.resolve(output));
            break;
          case "error":
            finish(() => completion.reject(new Error(event.message ?? "Engine failed")));
            break;
          default:
            throw new GatewayError(502, "ENGINE_PROTOCOL_ERROR", "Unknown engine event type");
        }
      }).catch((error) => finish(() => completion.reject(error)));
    });

    child.once("error", (error) => {
      finish(() =>
        completion.reject(
          new GatewayError(502, "ENGINE_PROCESS_ERROR", `Could not start engine: ${error.message}`),
        ),
      );
    });
    child.once("close", (code) => {
      void processing.finally(() => {
        if (!settled) {
          finish(() =>
            completion.reject(
              new GatewayError(
                502,
                "ENGINE_PROCESS_ERROR",
                `Engine exited before completion (code ${code ?? "unknown"})`,
                stderr ? { stderr: stderr.trim() } : undefined,
              ),
            ),
          );
        }
      });
    });

    write({
      type: "run",
      sessionId: context.sessionId,
      runId: context.runId,
      directory: context.directory,
      prompt,
      messages: context.messages,
    });

    try {
      return await completion.promise;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      lines.close();
      this.closeChild(child);
    }
  }

  private closeChild(child: ChildProcessWithoutNullStreams): void {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}
