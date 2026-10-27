import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";

/**
 * Reads an Airi chat run stream (lib/airi-chats/sse.ts) and hands each event's
 * JSON data to `onEvent`, in order. Frames without data, such as the ": ping"
 * keep-alive comments, are skipped. An error thrown by `onEvent` stops reading.
 */
export async function readAiriChatEventStream<TEvent = AiriChatRunEvent>(
  response: Response,
  onEvent: (event: TEvent) => void
) {
  if (!response.body) {
    throw new Error("Streaming response is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushEvent = (frame: string) => {
    let dataLine: string | undefined;
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        dataLine = trimmed;
        break;
      }
    }
    if (!dataLine) return;
    const raw = dataLine.slice("data:".length).trim();
    if (!raw) return;
    onEvent(JSON.parse(raw) as TEvent);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      flushEvent(frame);
      separator = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    flushEvent(buffer);
  }
}
