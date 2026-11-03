import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  alphaBox,
  amountLayer,
  balancedLines,
  captionLines,
  coverBackground,
  endingLayers,
  escapeMarkup,
  exactScene,
  feedStill,
  LABEL_MAX_WIDTH,
  labelLayer,
  presenterCircle,
  priceCardLayers,
  productSceneLayers,
  splitPrice,
  tagLayer,
  textLayer,
} from "./layers";
import { AD_FRAME, inside, REELS_SAFE } from "./layout";

const blob = async (width: number, height: number, color: string) =>
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
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${width * 0.2}" y="${height * 0.1}" width="${width * 0.6}" height="${height * 0.8}" fill="${color}"/></svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();

test("a price splits around its amount, as the shelf writes it", () => {
  assert.deepEqual(splitPrice("15 500 ₸ бастап"), {
    before: "",
    amount: "15 500 ₸",
    after: "бастап",
  });
  assert.deepEqual(splitPrice("от 15 500 ₸"), {
    before: "от",
    amount: "15 500 ₸",
    after: "",
  });
  assert.deepEqual(splitPrice("from 10 USD"), {
    before: "from",
    amount: "10 USD",
    after: "",
  });
  assert.deepEqual(splitPrice("5 000"), {
    before: "",
    amount: "5 000",
    after: "",
  });
  assert.deepEqual(splitPrice("Free"), {
    before: "",
    amount: "Free",
    after: "",
  });
});

test("words are escaped for Pango and broken into even lines", () => {
  assert.equal(escapeMarkup("Tom & <Jerry>"), "Tom &amp; &lt;Jerry&gt;");
  assert.deepEqual(balancedLines("Кукла", 2), ["Кукла"]);
  assert.deepEqual(balancedLines("Шежіре ағашы панно, жеті буын", 2), [
    "Шежіре ағашы",
    "панно, жеті буын",
  ]);
  assert.deepEqual(balancedLines("one two three", 1), ["one two three"]);
});

test("a caption breaks where its two lines come out even, within the checks' 26", () => {
  // The paid gate's toy shelf: the greedy break split «Көк көйлек».
  assert.deepEqual(captionLines("Сары шашты қуыршақ Көк көйлек киген"), [
    "Сары шашты қуыршақ",
    "Көк көйлек киген",
  ]);
  assert.deepEqual(captionLines("Отбасы тарихы ағашта"), [
    "Отбасы тарихы ағашта",
  ]);
  assert.deepEqual(captionLines(""), []);
  for (const caption of [
    "Құндылық қайта жаңғырды Домбырамен билейтін ортеке",
    "Отбасы тарихы ағашта Жеңіс бұрышына арналған",
    "A lovely gift for a little one who loves dolls",
    "Таңғы шайға арналған",
  ]) {
    const lines = captionLines(caption);
    assert.ok(lines.length >= 1 && lines.length <= 2, caption);
    for (const line of lines) assert.ok(Array.from(line).length <= 26, line);
  }
});

test("the label stays narrow enough for the tag beside it; a long name takes two lines", async () => {
  const short = await labelLayer({
    name: "Кукла Лол",
    caption: "Балаңызға керемет сыйлық",
  });
  const long = await labelLayer({
    name: "Шежіре ағашы панно, жеті буын, емен",
    caption: "Отбасыңыздың тарихы бір паннода",
  });
  assert.ok(short.width <= LABEL_MAX_WIDTH + 2, `${short.width}`);
  assert.ok(long.width <= LABEL_MAX_WIDTH + 2, `${long.width}`);
  assert.ok(long.height > short.height);
  const tag = await tagLayer("15 500 ₸ бастап");
  assert.ok(
    tag.width < 460,
    `the "from" word sits under the amount: ${tag.width}`,
  );
  // A markup character in a name is drawn, not read as markup.
  await labelLayer({ name: "Tom & <Jerry>", caption: "A & B" });
});

test("a product scene's words, the price card and the ending all stay inside the safe band", async () => {
  const doll = await blob(400, 640, "#3b82f6");
  const mug = await blob(500, 500, "#d1d5db");
  const table = await blob(1200, 700, "#8b5e34");
  const exact = await exactScene(doll);
  const { crop } = await coverBackground(exact.image, AD_FRAME, exact.box);
  const scene = await productSceneLayers({
    frame: "reels",
    product: crop.product,
    name: "Кукла Лол",
    caption: "Балаңызға керемет сыйлық",
    priceText: "5 000 ₸",
    sticker: "Сөремізде жаңа тауар",
  });
  for (const placed of [scene.label, scene.tag, scene.sticker!])
    assert.ok(inside(placed.rect, REELS_SAFE), JSON.stringify(placed.rect));

  const card = await priceCardLayers({
    title: "Біздің бағалар",
    products: [
      { cutout: doll, name: "Кукла Лол", priceText: "5 000 ₸" },
      { cutout: mug, name: "Кружка Web UMN", priceText: "500 ₸" },
      {
        cutout: table,
        name: "Билейтін үстел, ұзын атауы бар",
        priceText: "35 000 ₸ бастап",
      },
    ],
  });
  assert.ok(
    inside(card.title.rect, REELS_SAFE),
    JSON.stringify(card.title.rect),
  );
  assert.ok(inside(card.tags.rect, REELS_SAFE), JSON.stringify(card.tags.rect));
  const background = await sharp(card.background).metadata();
  assert.deepEqual([background.width, background.height], [1080, 1920]);

  const presenter = await blob(500, 900, "#c08457");
  for (const phone of ["+7 000 000 00 00", null]) {
    const ending = await endingLayers({
      cutouts: [doll, mug],
      presenter,
      shopName: "Demo Shop",
      ending: "Тапсырыс беру үшін жазыңыз",
      phone,
    });
    assert.ok(
      inside(ending.words.rect, REELS_SAFE),
      JSON.stringify(ending.words.rect),
    );
    assert.ok(
      inside(ending.pill.rect, REELS_SAFE),
      JSON.stringify(ending.pill.rect),
    );
  }
  // With no shop name and no number, the pill still says where to write.
  await endingLayers({
    cutouts: [doll],
    presenter: null,
    shopName: " ",
    ending: "Message us",
    phone: null,
  });
});

test("a long price is drawn whole on the price card's narrow tags, never cut", async () => {
  const NB = " ";
  const amountStyle = (px: number) =>
    ({ face: "display", weight: "semibold", px }) as const;
  // With 3 products, a price card tag gives its amount 213 px; this one
  // needs 227 at the old 24 px floor, which cut it to «1 500 000 0…».
  const long = `1${NB}500${NB}000${NB}000${NB}VND`;
  const drawn = await amountLayer(long, 50, 213);
  const whole = await textLayer([long], amountStyle(drawn.px));
  assert.equal(drawn.width, whole.width);
  assert.ok(drawn.width <= 213, `${drawn.width}`);
  // Too long even at the smallest size: wider than asked, but whole.
  const absurd = `999${NB}999${NB}999${NB}999.999${NB}KWD`;
  const tight = await amountLayer(absurd, 50, 60);
  const wholeTight = await textLayer([absurd], amountStyle(tight.px));
  assert.equal(tight.width, wholeTight.width);
  assert.ok(tight.width > 60);

  const product = await blob(400, 640, "#3b82f6");
  const card = await priceCardLayers({
    title: "Our prices",
    products: [1, 2, 3].map((n) => ({
      cutout: product,
      name: `Lamp ${n}`,
      priceText: long,
    })),
  });
  assert.ok(inside(card.tags.rect, REELS_SAFE), JSON.stringify(card.tags.rect));
});

test("a shop's name the fonts can't draw is left off the ending, number or not", async () => {
  const doll = await blob(400, 640, "#3b82f6");
  const ending = (shopName: string, phone: string | null) =>
    endingLayers({
      cutouts: [doll],
      presenter: null,
      shopName,
      ending: "Тапсырыс беру үшін жазыңыз",
      phone,
    });
  const size = (layer: { width: number; height: number }) => [
    layer.width,
    layer.height,
  ];
  for (const phone of ["+7 000 000 00 00", null]) {
    const none = await ending("", phone);
    // «Цветы 🌸» and «花店» would be drawn with boxes or a stranger's font.
    for (const undrawable of ["Цветы 🌸", "花店"]) {
      const drawn = await ending(undrawable, phone);
      assert.deepEqual(size(drawn.words.layer), size(none.words.layer));
      // Without a number the pill says "WhatsApp", as with no name at all.
      assert.deepEqual(size(drawn.pill.layer), size(none.pill.layer));
    }
    // A name the fonts draw still stands over the ending's words.
    const named = await ending("Demo Shop", phone);
    assert.ok(named.words.layer.height > none.words.layer.height);
  }
});

test("the exact still stands the cut-out, unchanged, on the plank under the words", async () => {
  const doll = await blob(400, 640, "#3b82f6");
  const exact = await exactScene(doll);
  const meta = await sharp(exact.image).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 1920]);
  // It stands on the plank (at 1200 px), below the safe band's top.
  assert.ok(Math.abs((exact.box.y + exact.box.h) * 1920 - 1206) < 2);
  assert.ok(exact.box.y * 1920 >= 560);
  // The product's colour is there, untouched.
  const { data } = await sharp(exact.image)
    .extract({
      left: Math.round((exact.box.x + exact.box.w / 2) * 1080),
      top: Math.round((exact.box.y + exact.box.h / 2) * 1920),
      width: 1,
      height: 1,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.ok(Math.abs(data[0]! - 0x3b) < 6 && Math.abs(data[2]! - 0xf6) < 6);
});

test("the presenter is a ringed circle of head and shoulders; an empty cut-out is refused", async () => {
  const circle = await presenterCircle(await blob(500, 900, "#c08457"));
  assert.deepEqual([circle.width, circle.height], [340, 352]);
  assert.equal(await alphaBox(await blob(10, 10, "rgba(0,0,0,0)")), null);
  const empty = await sharp({
    create: {
      width: 20,
      height: 20,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  await assert.rejects(presenterCircle(empty), /empty/);
});

test("the 4:5 picture is 1080x1350", async () => {
  const exact = await exactScene(await blob(400, 640, "#3b82f6"));
  const feed = await feedStill({
    picture: exact.image,
    box: exact.box,
    name: "Кукла Лол",
    caption: "Балаңызға керемет сыйлық",
    priceText: "5 000 ₸",
  });
  const meta = await sharp(feed).metadata();
  assert.deepEqual(
    [meta.format, meta.width, meta.height],
    ["jpeg", 1080, 1350],
  );
});
