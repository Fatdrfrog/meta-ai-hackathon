import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_AD_STUDIO_COLOURWAYS,
  PRODUCT_AD_STUDIO_SWEEPS,
} from "@icecore/temporal";
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
  exactSceneBox,
  feedStill,
  floatSceneLayers,
  LABEL_MAX_WIDTH,
  labelLayer,
  popSubjectLayer,
  presenterCircle,
  priceCardLayers,
  productSceneLayers,
  splitPrice,
  studioColourwayFor,
  studioSweepSvg,
  tagLayer,
  textLayer,
} from "./layers";
import {
  AD_FEED_FRAME,
  AD_FRAME,
  FEED_SAFE,
  inside,
  REELS_SAFE,
} from "./layout";

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

test("the exact still's box is worked out from the cut-out alone, as the still draws it", async () => {
  for (const [width, height] of [
    [400, 640],
    [900, 300],
    [200, 1200],
  ] as const) {
    const cutout = await blob(width, height, "#e5e7eb");
    assert.deepEqual(
      await exactSceneBox(cutout),
      (await exactScene(cutout)).box,
    );
  }
  const empty = await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  assert.equal(await exactSceneBox(empty), null);
});

test("the owner's zone moves a scene's words, on the 4:5 picture too", async () => {
  const product = { x: 300, y: 560, w: 480, h: 760 };
  const low = await productSceneLayers({
    frame: "reels",
    product,
    name: "Кукла Лол",
    caption: "Балаңызға керемет сыйлық",
    priceText: "5 000 ₸",
    sticker: "Жаңа тауар",
    zone: "bottom",
  });
  assert.equal(low.layout.zone, "bottom");
  assert.ok(low.sticker!.rect.y > REELS_SAFE.y + REELS_SAFE.h / 2);
  assert.ok(low.layout.textOverlap);
  const auto = await productSceneLayers({
    frame: "reels",
    product,
    name: "Кукла Лол",
    caption: "Балаңызға керемет сыйлық",
    priceText: "5 000 ₸",
    sticker: null,
  });
  assert.equal(auto.layout.zone, "top");
});

// ---------------------------------------------------------------------------
// Studio v3.

test("the studio colourway is the one the product stands out on: night for a pale one, never for a dark one", async () => {
  assert.equal(
    await studioColourwayFor(await blob(300, 500, "#f4f4f2")),
    "night",
  );
  assert.equal(
    await studioColourwayFor(await blob(300, 500, "#1d1d1f")),
    "white",
  );
  // A colourful product gets a light sweep.
  assert.notEqual(
    await studioColourwayFor(await blob(300, 500, "#3b82f6")),
    "night",
  );
  // Nothing opaque: the plain white sweep.
  const empty = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  assert.equal(await studioColourwayFor(empty), "white");
});

test("the studio sweep is drawn in the colourway's own colours, the contract's for the page's tiles too", async () => {
  for (const colourway of PRODUCT_AD_STUDIO_COLOURWAYS) {
    const svg = studioSweepSvg(
      { width: 1080, height: 1350 },
      colourway,
    ).toString();
    assert.ok(svg.includes(PRODUCT_AD_STUDIO_SWEEPS[colourway].top), colourway);
    assert.ok(
      svg.includes(PRODUCT_AD_STUDIO_SWEEPS[colourway].bottom),
      colourway,
    );
    const { data, info } = await sharp(
      studioSweepSvg({ width: 1080, height: 1350 }, colourway),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [1080, 1350]);
    // "night" is a warm evening, never black.
    const bottom = (info.height - 1) * info.width * info.channels;
    assert.ok(
      data[bottom]! + data[bottom + 1]! + data[bottom + 2]! > 40,
      colourway,
    );
  }
});

test("Float's layers: the cut-out hangs above where the exact still stands it, the shadow under it on the plank", async () => {
  const cut = await blob(400, 640, "#3b82f6");
  const floated = await floatSceneLayers(cut);
  const box = await exactSceneBox(cut);
  // Where the exact still stands the product, lifted.
  assert.ok(Math.abs(floated.product.x - box!.x * 1080) < 1);
  assert.equal(floated.subject.rect.y, floated.product.y - 16);
  assert.equal(floated.subject.rect.h, floated.product.h);
  const subject = await sharp(floated.subject.image).metadata();
  assert.deepEqual(
    [subject.width, subject.height],
    [floated.subject.width, floated.subject.height],
  );
  // The shadow: centred under the product's base, inside its layer at its smallest.
  const base = floated.product.y + floated.product.h;
  assert.ok(
    Math.abs(floated.shadow.rect.y + floated.shadow.rect.h / 2 - base) <= 1,
  );
  assert.ok(
    Math.abs(
      floated.shadow.rect.x +
        floated.shadow.rect.w / 2 -
        (floated.product.x + floated.product.w / 2),
    ) <= 1,
  );
  const wall = await sharp(floated.background).metadata();
  assert.deepEqual([wall.width, wall.height], [1080, 1920]);
});

test("Pop's layer: the cut-out fitted in its box, centred, with room to grow 8% and a shadow under it", async () => {
  const cut = await blob(400, 640, "#3b82f6");
  const rect = { x: 300, y: 600, w: 480, h: 500 };
  const { subject, product } = await popSubjectLayer(cut, rect);
  assert.ok(inside(product, rect));
  // Fitted: one side fills the box.
  assert.ok(product.w === rect.w || Math.abs(product.h - rect.h) <= 1);
  // The layer's centre is the product's, so the growth stays on it.
  assert.ok(
    Math.abs(
      subject.rect.x + subject.rect.w / 2 - (product.x + product.w / 2),
    ) <= 1,
  );
  assert.ok(
    Math.abs(
      subject.rect.y + subject.rect.h / 2 - (product.y + product.h / 2),
    ) <= 1,
  );
  // 8% larger still fits the layer.
  assert.ok(
    product.w * 1.08 < subject.width && product.h * 1.08 < subject.height,
  );
  const meta = await sharp(subject.image).metadata();
  assert.deepEqual([meta.width, meta.height], [subject.width, subject.height]);
  // The corners are clear: nothing is cut at the layer's edge.
  const ink = await alphaBox(subject.image);
  assert.ok(ink!.left > 0 && ink!.top > 0);
  assert.ok(
    ink!.left + ink!.width < subject.width &&
      ink!.top + ink!.height < subject.height,
  );
});

test("the price card drawn at 4:5 (Collection) keeps its title and tags inside the picture's margins", async () => {
  const card = await priceCardLayers({
    title: "Қуыршақ іздеп жүрсіз бе?",
    products: [
      {
        cutout: await blob(400, 640, "#3b82f6"),
        name: "Кукла Лол",
        priceText: "5 000 ₸",
      },
      {
        cutout: await blob(500, 500, "#e5e7eb"),
        name: "Кружка",
        priceText: "500 ₸",
      },
      {
        cutout: await blob(300, 600, "#ec4899"),
        name: "Телефон",
        priceText: "2 000 ₸ бастап",
      },
    ],
    frame: {
      size: AD_FEED_FRAME,
      safe: FEED_SAFE,
      plankTop: 900,
      maxHeight: 560,
    },
  });
  const meta = await sharp(card.background).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 1350]);
  assert.ok(inside(card.title.rect, FEED_SAFE));
  assert.ok(inside(card.tags.rect, FEED_SAFE));
});
