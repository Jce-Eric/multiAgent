const baseUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:3000";
const apiKey = process.env.GATEWAY_API_KEY;
const headers = {
  "content-type": "application/json",
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
};

const events = await fetch(`${baseUrl}/v1/events`, { headers });
if (!events.ok || !events.body) throw new Error(`SSE failed: ${events.status}`);

const session = await request("/v1/sessions", {
  method: "POST",
  body: JSON.stringify({ directory: process.cwd() }),
});
const sessionId = session.session.id as string;
const accepted = await request(`/v1/sessions/${sessionId}/messages`, {
  method: "POST",
  body: JSON.stringify({ content: "Inspect this project and summarize it." }),
});

const reader = events.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let boundary = buffer.indexOf("\n\n");
  while (boundary >= 0) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (data) {
      const event = JSON.parse(data);
      if (event.runId === accepted.runId) {
        console.log(event.type, event.data);
        if (["generation.completed", "generation.failed", "generation.stopped"].includes(event.type)) {
          process.exit(event.type === "generation.completed" ? 0 : 1);
        }
      }
    }
    boundary = buffer.indexOf("\n\n");
  }
}

async function request(pathname: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
