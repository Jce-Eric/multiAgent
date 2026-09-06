import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { availableEngines } from "./engines/registry.js";
import { GatewayError } from "./errors.js";

interface CliOptions {
  engine?: string;
  host: string;
  port: number;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    engine: process.env.AGENT_ENGINE,
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inlineValue] = arg.split("=", 2);
    const nextValue = () => inlineValue ?? args[++index];
    if (flag === "--engine") options.engine = nextValue();
    else if (flag === "--host") options.host = nextValue();
    else if (flag === "--port") options.port = Number(nextValue());
    else if (flag === "--help" || flag === "-h") {
      console.log(`Usage: npm start -- [options]\n\nOptions:\n  --engine <name>  ${availableEngines().join(", ")}\n  --host <host>    default: 127.0.0.1\n  --port <port>    default: 3000`);
      process.exit(0);
    } else {
      throw new GatewayError(400, "VALIDATION_ERROR", `Unknown argument '${arg}'`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new GatewayError(400, "VALIDATION_ERROR", "Port must be an integer from 0 to 65535");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { app, service } = createApp({ engine: options.engine });
  const server = createServer(app);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    console.log(`multi-agent-gateway listening on http://${options.host}:${port} (engine=${service.engine.name})`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main().catch((error) => {
    if (error instanceof GatewayError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
