import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Phone clips arrive as rotated HEVC .mov files. Muse Spark takes MP4 only, and SAM remuxes
// files whose index sits at the end, so normalize once: upright H.264 with the short side at
// most 720 px (portrait stays sharp enough for product detail), audio kept for the narration,
// index first.
export async function normalizeVideo(path: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(path, extname(path))}.normalized.mp4`);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(path).mtimeMs) return out;
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", path,
    "-vf", "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac",
    "-movflags", "+faststart",
    out,
  ]);
  return out;
}

export async function countFrames(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path,
  ]);
  const frames = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(frames)) throw new Error(`ffprobe could not count frames in ${path}: "${stdout}"`);
  return frames;
}

/** JPEG frames sampled at `fps` between two moments, in order, with their approximate time. */
export async function extractFrames(
  path: string,
  fromS: number,
  toS: number,
  fps: number,
  outDir: string,
): Promise<{ path: string; timeS: number }[]> {
  mkdirSync(outDir, { recursive: true });
  const start = Math.max(0, fromS);
  await run("ffmpeg", [
    "-y", "-v", "error", "-ss", start.toFixed(3), "-i", path,
    "-t", Math.max(0.1, toS - start).toFixed(3),
    "-vf", `fps=${fps}`, "-q:v", "2", join(outDir, "frame-%03d.jpg"),
  ]);
  return readdirSync(outDir)
    .filter((name) => /^frame-\d+\.jpg$/.test(name))
    .sort()
    .map((name, i) => ({ path: join(outDir, name), timeS: start + i / fps }));
}

export async function extractCrop(
  path: string,
  frame: number,
  box: { left: number; top: number; right: number; bottom: number },
  out: string,
): Promise<void> {
  const width = Math.max(1, Math.round(box.right - box.left));
  const height = Math.max(1, Math.round(box.bottom - box.top));
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", path,
    "-vf", `select=eq(n\\,${frame}),crop=${width}:${height}:${Math.round(box.left)}:${Math.round(box.top)}`,
    "-frames:v", "1", "-update", "1", out,
  ]);
}
