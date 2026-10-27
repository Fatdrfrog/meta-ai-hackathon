import { runProcess, type ProcessRunInput } from "./process-runner";

export type VideoProbeResult = {
  durationSeconds: number;
  width: number;
  height: number;
  mimeType: string;
};

type RunProcess = (
  input: ProcessRunInput,
) => Promise<{ stdout: string; stderr: string }>;

function positive(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function mimeFromFormat(value: unknown): string {
  const formats = String(value || "")
    .toLowerCase()
    .split(",");
  if (
    formats.some((format) =>
      ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"].includes(format),
    )
  )
    return "video/mp4";
  if (formats.includes("webm")) return "video/webm";
  if (formats.includes("matroska")) return "video/x-matroska";
  return "application/octet-stream";
}

export function parseVideoProbeOutput(stdout: string): VideoProbeResult {
  let payload: {
    streams?: Array<{
      codec_type?: string;
      width?: unknown;
      height?: unknown;
      duration?: unknown;
    }>;
    format?: { duration?: unknown; format_name?: unknown };
  };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  const video = payload.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  if (!video) throw new Error("ffprobe did not return a video stream");
  const width = positive(video.width);
  const height = positive(video.height);
  if (!width || !height)
    throw new Error("ffprobe returned invalid video dimensions");
  const durationSeconds =
    positive(video.duration) ?? positive(payload.format?.duration);
  if (!durationSeconds)
    throw new Error("ffprobe returned invalid video duration");
  return {
    durationSeconds,
    width: Math.floor(width),
    height: Math.floor(height),
    mimeType: mimeFromFormat(payload.format?.format_name),
  };
}

export async function probeVideoFile(
  inputPath: string,
  deps: { runProcess?: RunProcess } = {},
): Promise<VideoProbeResult> {
  const result = await (deps.runProcess ?? runProcess)({
    command: "ffprobe",
    args: [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      inputPath,
    ],
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
  });
  return parseVideoProbeOutput(result.stdout);
}
