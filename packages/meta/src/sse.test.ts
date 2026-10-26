import assert from "node:assert/strict";
import { test } from "node:test";
import { readSseData } from "./sse.ts";

async function collect(chunks: readonly string[]): Promise<string[]> {
  const encoder = new TextEncoder();
  async function* source() {
    for (const chunk of chunks) yield encoder.encode(chunk);
  }
  const events: string[] = [];
  for await (const data of readSseData(source())) events.push(data);
  return events;
}

test("joins an event split across chunks", async () => {
  assert.deepEqual(await collect(['data: {"a"', ":1}\n\nda", "ta: [DONE]\n\n"]), ['{"a":1}', "[DONE]"]);
});

test("handles CRLF line endings, including a \\r\\n split between chunks", async () => {
  assert.deepEqual(await collect(["event: x\r\ndata: one\r", "\n\r\ndata: two\r\n\r\n"]), ["one", "two"]);
});

test("joins multi-line data and skips events without data", async () => {
  assert.deepEqual(await collect([": keep-alive\n\ndata: a\ndata: b\n\n"]), ["a\nb"]);
});

test("yields a last event that has no trailing blank line", async () => {
  assert.deepEqual(await collect(["data: last"]), ["last"]);
});
