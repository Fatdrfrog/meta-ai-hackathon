import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";

import type { Pcm } from "./audio";
import { composeAd } from "./compose";
import { exactScene } from "./layers";
import { planTimeline, REELS_SAFE } from "./layout";
import {
  AD_MAX_VIDEO_BYTES,
  AdTooBigError,
  posterFrame,
  renderAd,
  renderArgs,
  tagDrop,
  type RenderPlan,
  type RenderScene,
} from "./render";

const FULL = { size: { width: 1080, height: 1920 }, crf: 21 };

/** A plan as compose.ts makes it, for `products` scenes with or without words. */
function plan(voices: Array<number | null>, voice: boolean): RenderPlan {
  const timeline = planTimeline(
    voices.map((voiceSeconds) => ({ voiceSeconds })),
  );
  const scene = (
    index: number,
    overrides: Partial<RenderScene> = {},
  ): RenderScene => ({
    background: `scene-${index}.jpg`,
    focus: { x: 0.5, y: 0.47 },
    zoomTo: 1.06,
    seconds: timeline.scenes[index]!.seconds,
    label: { path: `scene-${index}-label.png`, x: 72, y: 276 },
    // A paper tag's ink starts under its shadow's clear 12 px margin.
    tag: { path: `scene-${index}-tag.png`, x: 659, y: 276, inkTop: 12 },
    sticker: null,
    transition: index < voices.length - 1 ? "slideleft" : "fade",
    ...overrides,
  });
  const scenes = voices.map((_, index) =>
    scene(
      index,
      index === 0
        ? { sticker: { path: "scene-0-sticker.png", x: 72, y: 276 } }
        : {},
    ),
  );
  scenes.push(
    scene(voices.length, {
      background: "price-card.png",
      zoomTo: 1.025,
      label: { path: "price-card-title.png", x: 230, y: 293 },
      tag: { path: "price-card-tags.png", x: 99, y: 1087 },
      transition: "fade",
    }),
    scene(voices.length + 1, {
      background: "ending.png",
      zoomTo: 1,
      label: { path: "ending-words.png", x: 197, y: 700 },
      tag: { path: "ending-pill.png", x: 133, y: 1005 },
      transition: null,
    }),
  );
  return {
    scenes,
    starts: timeline.scenes.map((entry) => entry.start),
    totalSeconds: timeline.totalSeconds,
    voice: voice ? "voice.wav" : null,
  };
}

const graphOf = (args: string[]) =>
  args[args.indexOf("-filter_complex") + 1]!.split(";");

test("the graph for one product: push-in, sticker then words, cross-fades, silence", () => {
  const args = renderArgs(plan([null], false), "ad.mp4", FULL);
  const graph = graphOf(args);
  assert.deepEqual(graph, [
    "[0:v]format=rgb24,scale=2160:3840:flags=lanczos,zoompan=z='1+0.06*on/143':x='max(0,min(iw-iw/zoom,0.5*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,0.47*ih-ih/zoom/2))':d=143:s=1080x1920:fps=30,setsar=1,format=yuv420p[bg0]",
    "[1:v]format=rgba,loop=loop=142:size=1:start=0,setpts=N/30/TB,fade=t=in:st=0.2:d=0.2:alpha=1,fade=t=out:st=1.6:d=0.2:alpha=1[sticker0]",
    "[bg0][sticker0]overlay=x=72:y='276':format=auto[stickeron0]",
    "[2:v]format=rgba,loop=loop=142:size=1:start=0,setpts=N/30/TB,fade=t=in:st=1.9:d=0.35:alpha=1[label0]",
    "[stickeron0][label0]overlay=x=72:y='276+18*(1-min(1,max(0,(t-1.9)/0.35)))':format=auto[labelon0]",
    "[3:v]format=rgba,loop=loop=142:size=1:start=0,setpts=N/30/TB,fade=t=in:st=2.2:d=0.3:alpha=1[tag0]",
    // At the safe band's top, the tag drops only as far as keeps its ink inside.
    "[labelon0][tag0]overlay=x=659:y='276-19*(1-min(1,max(0,(t-2.2)/0.3)))':format=auto[tagon0]",
    "[tagon0]trim=duration=4.7667,setpts=PTS-STARTPTS,format=yuv420p[scene0]",
    "[4:v]format=rgb24,scale=2160:3840:flags=lanczos,zoompan=z='1+0.025*on/90':x='max(0,min(iw-iw/zoom,0.5*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,0.47*ih-ih/zoom/2))':d=90:s=1080x1920:fps=30,setsar=1,format=yuv420p[bg1]",
    "[5:v]format=rgba,loop=loop=89:size=1:start=0,setpts=N/30/TB,fade=t=in:st=0.3:d=0.35:alpha=1[label1]",
    "[bg1][label1]overlay=x=230:y='293+18*(1-min(1,max(0,(t-0.3)/0.35)))':format=auto[labelon1]",
    "[6:v]format=rgba,loop=loop=89:size=1:start=0,setpts=N/30/TB,fade=t=in:st=0.6:d=0.3:alpha=1[tag1]",
    "[labelon1][tag1]overlay=x=99:y='1087-26*(1-min(1,max(0,(t-0.6)/0.3)))':format=auto[tagon1]",
    "[tagon1]trim=duration=3,setpts=PTS-STARTPTS,format=yuv420p[scene1]",
    "[7:v]format=rgb24,scale=1080:1920:flags=lanczos,zoompan=z=1:x=0:y=0:d=90:s=1080x1920:fps=30,setsar=1,format=yuv420p[bg2]",
    "[8:v]format=rgba,loop=loop=89:size=1:start=0,setpts=N/30/TB,fade=t=in:st=0.3:d=0.35:alpha=1[label2]",
    "[bg2][label2]overlay=x=197:y='700+18*(1-min(1,max(0,(t-0.3)/0.35)))':format=auto[labelon2]",
    "[9:v]format=rgba,loop=loop=89:size=1:start=0,setpts=N/30/TB,fade=t=in:st=0.6:d=0.3:alpha=1[tag2]",
    "[labelon2][tag2]overlay=x=133:y='1005-26*(1-min(1,max(0,(t-0.6)/0.3)))':format=auto[tagon2]",
    "[tagon2]trim=duration=3,setpts=PTS-STARTPTS,format=yuv420p[scene2]",
    "[scene0][scene1]xfade=transition=fade:duration=0.35:offset=4.4[joined1]",
    "[joined1][scene2]xfade=transition=fade:duration=0.35:offset=7.0333[joined2]",
    "[joined2]format=yuv420p[vout]",
    "anullsrc=r=48000:cl=stereo,atrim=duration=10.0333[aout]",
  ]);
  // Every input is a local file read by the demuxer named for it.
  const inputs = args.filter((arg, i) => args[i - 1] === "-i");
  assert.equal(inputs.length, 10);
  assert.equal(args.filter((arg) => arg === "-protocol_whitelist").length, 10);
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), [
    "-map",
    "[vout]",
    "-map",
    "[aout]",
  ]);
  for (const flag of [
    ["-c:v", "libx264"],
    ["-preset", "veryfast"],
    ["-crf", "21"],
    ["-profile:v", "high"],
    ["-level:v", "4.0"],
    ["-pix_fmt", "yuv420p"],
    ["-r", "30"],
    ["-g", "60"],
    ["-c:a", "aac"],
    ["-b:a", "128k"],
    ["-ar", "48000"],
    ["-movflags", "+faststart"],
  ])
    assert.equal(args[args.indexOf(flag[0]!) + 1], flag[1], `${flag[0]}`);
});

test("the graph for two and three products, with the owner's words and without", () => {
  for (const voices of [
    [3.1, 4.2],
    [null, null],
    [5.2, 5.6, 5.9],
    [null, null, null],
  ]) {
    for (const voice of [true, false]) {
      const p = plan(voices, voice);
      const graph = graphOf(renderArgs(p, "ad.mp4", FULL));
      const xfades = graph.filter((line) => line.includes("xfade="));
      assert.equal(xfades.length, voices.length + 1);
      // Products slide into each other; the price card and the ending fade.
      assert.deepEqual(
        xfades.map((line) => /transition=(\w+)/.exec(line)![1]),
        [...voices.slice(1).map(() => "slideleft"), "fade", "fade"],
      );
      xfades.forEach((line, index) =>
        assert.match(
          line,
          new RegExp(`offset=${Number(p.starts[index + 1]!.toFixed(4))}\\[`),
        ),
      );
      // Only the first scene has the sticker.
      assert.equal(
        graph.filter((line) => line.includes("fade=t=out")).length,
        1,
      );
      assert.ok(graph.some((line) => line.endsWith("[sticker0]")));
      assert.equal(
        graph.some((line) => line.startsWith("anullsrc")),
        !voice,
      );
      // Every filter is one ffmpeg 5.1 has.
      // A chain is "[in]filter=options,filter=options[out]": drop the quoted
      // expressions and the pad labels, and each filter's name is before "=".
      const filters = new Set(
        graph.flatMap((line) =>
          line
            .replace(/'[^']*'/g, "")
            .replace(/\[[^\]]*\]/g, ",")
            .split(",")
            .map((part) => part.split("=")[0]!.trim())
            .filter((name) => /^[a-z]+$/.test(name)),
        ),
      );
      assert.ok(filters.has("zoompan") && filters.has("xfade"));
      for (const name of filters)
        assert.ok(
          [
            "format",
            "scale",
            "zoompan",
            "setsar",
            "loop",
            "setpts",
            "fade",
            "overlay",
            "trim",
            "xfade",
            "anullsrc",
            "atrim",
          ].includes(name),
          `${name} isn't on the 5.1 list`,
        );
    }
  }
});

test("the graph is drawn at the output's size: the 720p fallback scales the layers", () => {
  const graph = graphOf(
    renderArgs(plan([null], true), "ad.mp4", {
      size: { width: 720, height: 1280 },
      crf: 25,
    }),
  );
  assert.match(graph[0]!, /scale=1440:2560/);
  assert.match(graph[0]!, /s=720x1280/);
  assert.match(graph[1]!, /scale=iw\*0\.6667:ih\*0\.6667/);
  assert.match(graph[2]!, /overlay=x=48:y='184'/);
});

test("a tag drops in 26 px, less at the safe band's top: its ink never starts above the band", async (t) => {
  assert.equal(tagDrop({ path: "t.png", x: 0, y: 276, inkTop: 12 }), 19);
  assert.equal(tagDrop({ path: "t.png", x: 0, y: 1087, inkTop: 12 }), 26);
  // Without its margin known, the layer's top row counts as ink.
  assert.equal(tagDrop({ path: "t.png", x: 0, y: 276 }), 7);

  // The real tags, as compose.ts places them: the paid gate's tags at
  // 276 px dropped from 250, their ink 6 px above the band.
  const dir = await mkdtemp(join(tmpdir(), "product-ad-drop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doll = await cutout("#3b82f6", 400, 640);
  const exact = await exactScene(doll);
  const composed = await composeAd({
    products: [
      {
        productId: "doll",
        name: "Кукла Лол",
        priceText: "5 000 ₸",
        cutout: doll,
        picture: exact.image,
        box: exact.box,
        caption: "Балаңызға керемет сыйлық",
        voice: null,
      },
    ],
    sticker: "Сөремізде жаңа тауар",
    priceCardTitle: "Біздің бағалар",
    ending: "Тапсырыс беру үшін жазыңыз",
    shopName: "Demo Shop",
    phone: null,
    presenter: null,
    workDir: dir,
  });
  const tags = composed.plan.scenes.flatMap((scene) =>
    scene.tag ? [scene.tag] : [],
  );
  assert.equal(tags.length, 3);
  assert.ok((tags[0]!.inkTop ?? 0) > 0, "the scene's tag knows its margin");
  for (const tag of tags)
    assert.ok(
      tag.y + (tag.inkTop ?? 0) - tagDrop(tag) >= REELS_SAFE.y,
      JSON.stringify(tag),
    );
});

test("over 16 MB: again at CRF 25, then at 720x1280; still over, the ad is too big", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "product-ad-ladder-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "ad.mp4");
  const runs: string[][] = [];
  const sizes =
    (bytes: number[]) =>
    async ({ args }: { args: string[] }) => {
      runs.push(args);
      await writeFile(out, Buffer.alloc(bytes[runs.length - 1] ?? 0));
      return { stdout: "", stderr: "" };
    };
  const big = AD_MAX_VIDEO_BYTES + 1;
  const result = await renderAd(plan([null], false), out, {
    runProcess: sizes([big, big, 9_000_000]),
  });
  assert.deepEqual(result.size, { width: 720, height: 1280 });
  assert.equal(result.crf, 25);
  assert.equal(result.bytes, 9_000_000);
  assert.deepEqual(
    runs.map((args) => args[args.indexOf("-crf") + 1]),
    ["21", "25", "25"],
  );

  runs.length = 0;
  await assert.rejects(
    renderAd(plan([null], false), out, { runProcess: sizes([big, big, big]) }),
    AdTooBigError,
  );
  runs.length = 0;
  const first = await renderAd(plan([null], false), out, {
    runProcess: sizes([3_200_000]),
  });
  assert.equal(runs.length, 1);
  assert.equal(first.crf, 21);
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const cutout = async (color: string, width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.4}" ry="${height * 0.45}" fill="${color}"/></svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();

test("a 270x480 smoke render on the local ffmpeg: the real layers, words and silence", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg is not installed");
  const dir = await mkdtemp(join(tmpdir(), "product-ad-smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doll = await cutout("#3b82f6", 400, 640);
  const panel = await cutout("#8b5e34", 700, 900);
  const words: Pcm = { samples: new Int16Array(48000 * 2), sampleRate: 48000 };
  for (let i = 0; i < words.samples.length; i++)
    words.samples[i] = Math.round(
      6000 * Math.sin((2 * Math.PI * 180 * i) / 48000),
    );
  const products = await Promise.all(
    [
      {
        id: "doll",
        name: "Кукла Лол",
        price: "5 000 ₸",
        cut: doll,
        voice: words,
      },
      {
        id: "panel",
        name: "Шежіре ағашы",
        price: "15 500 ₸ бастап",
        cut: panel,
        voice: null,
      },
    ].map(async (product) => {
      const exact = await exactScene(product.cut);
      return {
        productId: product.id,
        name: product.name,
        priceText: product.price,
        cutout: product.cut,
        picture: exact.image,
        box: exact.box,
        caption: "Әғқңөұүһі сыйлық",
        voice: product.voice,
      };
    }),
  );
  const composed = await composeAd({
    products,
    sticker: "Сөремізде жаңа тауар",
    priceCardTitle: "Біздің бағалар",
    ending: "Тапсырыс беру үшін жазыңыз",
    shopName: "Demo Shop",
    phone: null,
    presenter: null,
    workDir: dir,
  });
  assert.ok(composed.plan.voice, "the words make a voice track");
  const out = join(dir, "ad.mp4");
  const rendered = await renderAd(composed.plan, out, {}, [
    { size: { width: 270, height: 480 }, crf: 30 },
  ]);
  assert.deepEqual(rendered.size, { width: 270, height: 480 });
  const probe = JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      out,
    ]).toString(),
  ) as {
    streams: Array<Record<string, string | number>>;
    format: { duration: string };
  };
  const video = probe.streams.find((stream) => stream.codec_type === "video")!;
  const audio = probe.streams.find((stream) => stream.codec_type === "audio")!;
  assert.equal(video.codec_name, "h264");
  assert.equal(video.profile, "High");
  assert.equal(video.width, 270);
  assert.equal(video.height, 480);
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(audio.codec_name, "aac");
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(audio.channels, 2);
  assert.ok(
    Math.abs(Number(probe.format.duration) - composed.timeline.totalSeconds) <
      0.1,
  );
  assert.ok(
    composed.timeline.totalSeconds >= 10 &&
      composed.timeline.totalSeconds <= 20,
  );
  assert.ok((await stat(out)).size < AD_MAX_VIDEO_BYTES);

  const poster = join(dir, "poster.jpg");
  await posterFrame(out, poster);
  const meta = await sharp(poster).metadata();
  assert.deepEqual([meta.width, meta.height], [270, 480]);
  // The stills: 9:16 Status picture and 4:5 ad picture.
  const status = await sharp(composed.status).metadata();
  const feed = await sharp(composed.feed).metadata();
  assert.deepEqual([status.width, status.height], [1080, 1920]);
  assert.deepEqual([feed.width, feed.height], [1080, 1350]);
});
