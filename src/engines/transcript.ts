import type { Message } from "../types.js";

export function prependTranscript(prompt: string, messages: readonly Message[]): string {
  if (!messages.length) return prompt;
  const transcript = messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  return [
    "The following conversation history was restored by the gateway. Continue from it without repeating it.",
    "<conversation_history>",
    transcript,
    "</conversation_history>",
    "",
    `USER: ${prompt}`,
  ].join("\n");
}
