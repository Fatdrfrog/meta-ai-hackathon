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

/** Mono 16 kHz MP3 of the narration: small enough to send inline, and both Meta APIs accept MP3. */
export async function extractAudio(path: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(path, extname(path))}.narration.mp3`);
  await run("ffmpeg", ["-y", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", out]);
  return out;
}

/** The video without its sound track. */
export async function muteVideo(path: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(path, extname(path))}.muted.mp4`);
  await run("ffmpeg", ["-y", "-v", "error", "-i", path, "-an", "-c:v", "copy", "-movflags", "+faststart", out]);
  return out;
}

export interface PreparedVideo {
  /** Upright H.264 MP4 with no sound, for Muse Spark and SAM. */
  readonly video: string;
  /** The narration as MP3, for the speech model. */
  readonly audio: string;
  readonly durationS: number;
}

// Muse Spark gets the picture only: given the sound too, it sometimes invented its own narration
// instead of using the transcript (docs/findings.md).
export async function prepareVideo(sourcePath: string, outDir: string): Promise<PreparedVideo> {
  const normalized = await normalizeVideo(sourcePath, outDir);
  const [video, audio, durationS] = await Promise.all([
    muteVideo(normalized, outDir),
    extractAudio(normalized, outDir),
    durationSeconds(normalized),
  ]);
  return { video, audio, durationS };
}

export async function durationSeconds(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe could not read the duration of ${path}: "${stdout}"`);
  return seconds;
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
