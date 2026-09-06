import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      type: "delta",
      text: `bridge:${process.cwd()}:${request.prompt}`,
    })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ type: "completed" })}\n`);
});
