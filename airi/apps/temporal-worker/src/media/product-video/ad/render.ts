import { stat } from "node:fs/promises";
import { WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES } from "@icecore/whatsapp/mediaTypes";
import { runProcess } from "../../process-runner";
import type { RunProcess } from "../media";
import { PULSE_INTERVAL_MS } from "../pulse";
import {
  AD_FPS,
  AD_STICKER_IN_SECONDS,
  AD_STICKER_OUT_SECONDS,
  AD_TRANSITION_SECONDS,
  REELS_SAFE,
  type Size,
} from "./layout";

// The video: one ffmpeg run over the layers layers.ts drew. Each scene's
// picture is decoded once, scaled up 2x so the slow push-in doesn't shimmer,
// and pushed in on its product (zoompan); its words fade in on paper (the
// label rises 18 px at 0.30 s, the tag drops 26 px at 0.60 s, less at the
// safe band's top; the first scene's sticker shows from 0.2 to 1.8 s before
// them); scenes cross-fade in 0.35 s. The graph is drawn at the output's
// size, so the 720x1280 fallback and the tests' 270x480 render run the same
// filters. Every filter here exists in Debian's ffmpeg 5.1: format, scale,
// zoompan, setsar, loop, setpts, fade, overlay, trim, xfade, anullsrc, atrim.

export const AD_VIDEO_SIZE: Size = { width: 1080, height: 1920 };
export const AD_SMALL_VIDEO_SIZE: Size = { width: 720, height: 1280 };
/** WhatsApp's limit for a video, which every ad stays under. */
export const AD_MAX_VIDEO_BYTES = WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES.video;
/** The poster: the first product scene, once its sticker or words are in. */
export const AD_POSTER_SECONDS = 1.2;

const RENDER_TIMEOUT_MS = 6 * 60_000;
const LABEL_IN = 0.3;
const LABEL_FADE = 0.35;
const LABEL_RISE = 18;
const TAG_IN = 0.6;
const TAG_FADE = 0.3;
const TAG_DROP = 26;
const STICKER_FADE = 0.2;
/** The first scene's words wait for the sticker to leave. */
const AFTER_STICKER = AD_STICKER_OUT_SECONDS + 0.1;

const INPUT_GUARD = ["-protocol_whitelist", "file"];

export type RenderLayer = {
  path: string;
  x: number;
  y: number;
  /** Clear rows at the layer's top (its shadow's margin) over its ink; 0 when unknown. */
  inkTop?: number;
};

/**
 * How far a tag drops in from: 26 px, or less for a tag at the top of the
 * safe band, so its ink never starts above the band, under the app's header
 * (the paid gate's tags at 276 px started 6 px above it).
 */
export function tagDrop(tag: RenderLayer): number {
  return Math.min(
    TAG_DROP,
    Math.max(0, tag.y + (tag.inkTop ?? 0) - REELS_SAFE.y),
  );
}

export type RenderScene = {
  /** The scene's picture at 1080x1920. */
  background: string;
  /** Where the camera pushes in, as fractions of the frame. */
  focus: { x: number; y: number };
  /** The push-in's last zoom: 1.06 for products, 1.025 for the price card, 1 for the ending. */
  zoomTo: number;
  seconds: number;
  /** Positions are in the 1080x1920 frame. */
  label: RenderLayer | null;
  tag: RenderLayer | null;
  sticker: RenderLayer | null;
  /** How this scene hands over to the next; null for the last. */
  transition: "fade" | "slideleft" | null;
};

export type RenderPlan = {
  scenes: RenderScene[];
  /** The scenes' start times in the video, from layout's timeline. */
  starts: number[];
  totalSeconds: number;
  /** The voice track (48 kHz stereo WAV); null for a silent ad. */
  voice: string | null;
};

export type RenderOptions = { size: Size; crf: number };

const fixed = (value: number, digits = 3) =>
  Number(value.toFixed(digits)).toString();

/**
 * The ffmpeg arguments that render `plan` to `outPath`. Pure, so the graph
 * can be checked without running it.
 */
export function renderArgs(
  plan: RenderPlan,
  outPath: string,
  options: RenderOptions,
): string[] {
  const { width, height } = options.size;
  const scale = width / AD_VIDEO_SIZE.width;
  const inputs: string[][] = [];
  const addImage = (path: string) => {
    inputs.push([
      ...INPUT_GUARD,
      "-format_whitelist",
      "image2",
      "-f",
      "image2",
      "-framerate",
      String(AD_FPS),
      "-i",
      path,
    ]);
    return inputs.length - 1;
  };
  const graph: string[] = [];
  const px = (value: number) => Math.round(value * scale);

  plan.scenes.forEach((scene, index) => {
    const frames = Math.max(1, Math.round(scene.seconds * AD_FPS));
    const bg = addImage(scene.background);
    const zoom = scene.zoomTo - 1;
    const fx = fixed(Math.min(1, Math.max(0, scene.focus.x)), 4);
    const fy = fixed(Math.min(1, Math.max(0, scene.focus.y)), 4);
    graph.push(
      zoom > 0
        ? `[${bg}:v]format=rgb24,scale=${width * 2}:${height * 2}:flags=lanczos,` +
            `zoompan=z='1+${fixed(zoom, 4)}*on/${frames}':` +
            `x='max(0,min(iw-iw/zoom,${fx}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${fy}*ih-ih/zoom/2))':` +
            `d=${frames}:s=${width}x${height}:fps=${AD_FPS},setsar=1,format=yuv420p[bg${index}]`
        : `[${bg}:v]format=rgb24,scale=${width}:${height}:flags=lanczos,` +
            `zoompan=z=1:x=0:y=0:d=${frames}:s=${width}x${height}:fps=${AD_FPS},setsar=1,format=yuv420p[bg${index}]`,
    );
    let base = `bg${index}`;
    const layer = (
      name: string,
      placed: RenderLayer,
      fades: string,
      y: string,
    ) => {
      const input = addImage(placed.path);
      graph.push(
        `[${input}:v]format=rgba,${scale !== 1 ? `scale=iw*${fixed(scale, 4)}:ih*${fixed(scale, 4)}:flags=lanczos,` : ""}` +
          `loop=loop=${frames - 1}:size=1:start=0,setpts=N/${AD_FPS}/TB,${fades}[${name}${index}]`,
      );
      graph.push(
        `[${base}][${name}${index}]overlay=x=${px(placed.x)}:y='${y}':format=auto[${name}on${index}]`,
      );
      base = `${name}on${index}`;
    };
    const labelIn = scene.sticker ? AFTER_STICKER : LABEL_IN;
    const tagIn = scene.sticker ? AFTER_STICKER + (TAG_IN - LABEL_IN) : TAG_IN;
    if (scene.sticker)
      layer(
        "sticker",
        scene.sticker,
        `fade=t=in:st=${fixed(AD_STICKER_IN_SECONDS)}:d=${fixed(STICKER_FADE)}:alpha=1,` +
          `fade=t=out:st=${fixed(AD_STICKER_OUT_SECONDS - STICKER_FADE)}:d=${fixed(STICKER_FADE)}:alpha=1`,
        String(px(scene.sticker.y)),
      );
    if (scene.label)
      layer(
        "label",
        scene.label,
        `fade=t=in:st=${fixed(labelIn)}:d=${fixed(LABEL_FADE)}:alpha=1`,
        `${px(scene.label.y)}+${px(LABEL_RISE)}*(1-min(1,max(0,(t-${fixed(labelIn)})/${fixed(LABEL_FADE)})))`,
      );
    if (scene.tag)
      layer(
        "tag",
        scene.tag,
        `fade=t=in:st=${fixed(tagIn)}:d=${fixed(TAG_FADE)}:alpha=1`,
        `${px(scene.tag.y)}-${px(tagDrop(scene.tag))}*(1-min(1,max(0,(t-${fixed(tagIn)})/${fixed(TAG_FADE)})))`,
      );
    graph.push(
      `[${base}]trim=duration=${fixed(frames / AD_FPS, 4)},setpts=PTS-STARTPTS,format=yuv420p[scene${index}]`,
    );
  });

  let joined = "scene0";
  for (let index = 1; index < plan.scenes.length; index++) {
    const out = `joined${index}`;
    graph.push(
      `[${joined}][scene${index}]xfade=transition=${plan.scenes[index - 1]!.transition ?? "fade"}:` +
        `duration=${fixed(AD_TRANSITION_SECONDS)}:offset=${fixed(plan.starts[index]!, 4)}[${out}]`,
    );
    joined = out;
  }
  graph.push(`[${joined}]format=yuv420p[vout]`);

  let audioMap: string;
  if (plan.voice) {
    inputs.push([...INPUT_GUARD, "-format_whitelist", "wav", "-i", plan.voice]);
    audioMap = `${inputs.length - 1}:a`;
  } else {
    graph.push(
      `anullsrc=r=48000:cl=stereo,atrim=duration=${fixed(plan.totalSeconds, 4)}[aout]`,
    );
    audioMap = "[aout]";
  }

  return [
    "-y",
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-threads",
    "2",
    "-filter_complex_threads",
    "2",
    ...inputs.flat(),
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[vout]",
    "-map",
    audioMap,
    "-t",
    fixed(plan.totalSeconds, 4),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(options.crf),
    "-profile:v",
    "high",
    "-level:v",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(AD_FPS),
    "-g",
    "60",
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

export type RenderDeps = {
  runProcess?: RunProcess;
  signal?: AbortSignal;
  pulse?: () => void;
};

const run = (args: string[], deps: RenderDeps) =>
  (deps.runProcess ?? runProcess)({
    command: "ffmpeg",
    args,
    timeoutMs: RENDER_TIMEOUT_MS,
    signal: deps.signal,
    onPulse: deps.pulse,
    pulseIntervalMs: deps.pulse ? PULSE_INTERVAL_MS : undefined,
  });

/** The ad stayed over WhatsApp's 16 MB at the smallest size it tries. */
export class AdTooBigError extends Error {
  constructor(readonly bytes: number) {
    super(
      `The video is ${bytes} bytes at 720x1280; WhatsApp takes at most ${AD_MAX_VIDEO_BYTES}`,
    );
    this.name = "AdTooBigError";
  }
}

/** The sizes and qualities tried, in order, until the video is under 16 MB. */
export const AD_RENDER_LADDER: RenderOptions[] = [
  { size: AD_VIDEO_SIZE, crf: 21 },
  { size: AD_VIDEO_SIZE, crf: 25 },
  { size: AD_SMALL_VIDEO_SIZE, crf: 25 },
];

/**
 * Renders the ad under WhatsApp's 16 MB: at 1080x1920 CRF 21, again at
 * CRF 25 when that's too big, then at 720x1280. Throws AdTooBigError when
 * the smallest is still over.
 */
export async function renderAd(
  plan: RenderPlan,
  outPath: string,
  deps: RenderDeps = {},
  ladder: RenderOptions[] = AD_RENDER_LADDER,
  maxBytes = AD_MAX_VIDEO_BYTES,
): Promise<{ bytes: number; size: Size; crf: number; ms: number }> {
  const started = Date.now();
  let bytes = 0;
  for (const options of ladder) {
    await run(renderArgs(plan, outPath, options), deps);
    bytes = (await stat(outPath)).size;
    if (bytes <= maxBytes)
      return {
        bytes,
        size: options.size,
        crf: options.crf,
        ms: Date.now() - started,
      };
  }
  throw new AdTooBigError(bytes);
}

/** The poster: one frame of the video as JPEG. */
export async function posterFrame(
  videoPath: string,
  outPath: string,
  deps: RenderDeps = {},
  atSeconds = AD_POSTER_SECONDS,
): Promise<void> {
  await run(
    [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-ss",
      fixed(atSeconds),
      ...INPUT_GUARD,
      "-format_whitelist",
      "mov",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outPath,
    ],
    deps,
  );
}
