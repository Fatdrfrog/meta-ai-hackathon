import assert from "node:assert/strict";
import test from "node:test";

import { parseVideoProbeOutput, probeVideoFile } from "./video-probe";

test("parses the first video stream and normalizes MP4 MIME", () => {
  assert.deepEqual(
    parseVideoProbeOutput(
      JSON.stringify({
        streams: [
          { codec_type: "audio" },
          { codec_type: "video", width: 1080, height: 1920, duration: "6.25" },
        ],
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "6.25" },
      }),
    ),
    { durationSeconds: 6.25, width: 1080, height: 1920, mimeType: "video/mp4" },
  );
});

test("rejects missing video and invalid dimensions or duration", () => {
  assert.throws(
    () => parseVideoProbeOutput('{"streams":[],"format":{}}'),
    /video stream/i,
  );
  assert.throws(
    () =>
      parseVideoProbeOutput(
        '{"streams":[{"codec_type":"video","width":0,"height":10,"duration":"2"}]}',
      ),
    /dimensions/i,
  );
  assert.throws(
    () =>
      parseVideoProbeOutput(
        '{"streams":[{"codec_type":"video","width":10,"height":10,"duration":"NaN"}]}',
      ),
    /duration/i,
  );
});

test("invokes ffprobe with the generic JSON metadata shape", async () => {
  const calls: unknown[] = [];
  const result = await probeVideoFile("C:/tmp/video.mp4", {
    runProcess: async (input) => {
      calls.push(input);
      return {
        stdout:
          '{"streams":[{"codec_type":"video","width":640,"height":360}],"format":{"duration":"4","format_name":"mp4"}}',
        stderr: "",
      };
    },
  });
  assert.equal(result.durationSeconds, 4);
  assert.deepEqual(calls, [
    {
      command: "ffprobe",
      args: [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        "C:/tmp/video.mp4",
      ],
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    },
  ]);
});
