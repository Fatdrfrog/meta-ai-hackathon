import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
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
