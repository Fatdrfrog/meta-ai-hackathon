// Yields the data payload of each server-sent event, joining multi-line data fields.
export async function* readSseData(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const data = dataOf(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (data !== undefined) yield data;
      end = buffer.indexOf("\n\n");
    }
  }
  const data = dataOf((buffer + decoder.decode()).replaceAll("\r\n", "\n"));
  if (data !== undefined) yield data;
}

function dataOf(block: string): string | undefined {
  const lines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
  return lines.length > 0 ? lines.join("\n") : undefined;
}
