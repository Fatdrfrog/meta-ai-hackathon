import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_AD_STILL_KINDS,
  PRODUCT_AD_STILL_SET_MAX,
  PRODUCT_AD_STILL_SHAPES,
  PRODUCT_AD_STUDIO_COLOURWAYS,
} from "@icecore/temporal";
import sharp from "sharp";

import { exactScene, studioColourwayFor } from "./layers";
import {
  bigPriceLayout,
  drawAdStills,
  gridLayout,
  PRICE_LIST_NAME_MIN_PX,
  PRICE_LIST_NAME_PX,
  priceListLayout,
  printLayout,
  spotlightLayout,
  STORY_SAFE,
  stillFileName,
  studioOrder,
  type StillsInput,
  type StillsProduct,
} from "./stills";

const cutout = (width: number, height: number, color: string) =>
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
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${width * 0.15}" y="${height * 0.08}" width="${width * 0.7}" height="${height * 0.84}" rx="20" fill="${color}"/></svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();

async function product(
  productId: string,
  color: string,
  name: string,
  priceText: string,
): Promise<StillsProduct> {
  const cut = await cutout(400, 640, color);
  const exact = await exactScene(cut);
  return {
    productId,
    name,
    priceText,
    caption: "Балаңызға керемет сыйлық",
    cutout: cut,
    picture: exact.image,
    box: exact.box,
  };
}

async function input(
  overrides: Partial<StillsInput> = {},
): Promise<StillsInput> {
  return {
    products: [
      await product("p1", "#3b82f6", "Кукла Лол", "5 000 ₸"),
      await product("p2", "#f4f4f2", "Кружка", "500 ₸"),
      await product("p3", "#ec4899", "Шежіре ағашы", "15 500 ₸ бастап"),
    ],
    sticker: "Қуыршақ іздеп жүрсіз бе?",
    priceCardTitle: "Біздің бағалар",
    ending: "WhatsApp-қа жазып тапсырыс беріңіз",
    shopName: "Demo Shop",
    phone: null,
    ...overrides,
  };
}

test("three products: all 34 stills, in the stillSet's order, each at its format's size as a JPEG", async () => {
  const stills = await drawAdStills(await input());
  assert.equal(stills.length, PRODUCT_AD_STILL_SET_MAX);
  const order = stills.map(
    (still) =>
      `${still.kind}/${still.format}/${still.productId ?? "all"}${still.colourway ? `/${still.colourway}` : ""}`,
  );
  for (const id of ["p1", "p2", "p3"]) {
    const mine = order.filter((entry) => entry.includes(`/${id}`));
    assert.deepEqual(
      mine.map((entry) => entry.split("/").slice(0, 2).join("/")),
      [
        "room/feed",
        ...Array(5).fill("studio/feed"),
        "big_price/feed",
        "big_price/story",
        "spotlight/story",
        "print/feed",
      ],
      id,
    );
  }
  assert.deepEqual(order.slice(-4), [
    "collection/feed/all",
    "price_list/story/all",
    "grid/feed/all",
    "grid/story/all",
  ]);
  for (const still of stills) {
    const meta = await sharp(still.image).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.space, "srgb");
    assert.deepEqual(
      [meta.width, meta.height],
      still.format === "feed" ? [1080, 1350] : [1080, 1920],
      `${still.kind}/${still.format}`,
    );
  }
});

test("the stills follow the contract's shapes: formats, per product or not, a colourway only on studio", async () => {
  const stills = await drawAdStills(await input());
  for (const kind of PRODUCT_AD_STILL_KINDS) {
    const shape = PRODUCT_AD_STILL_SHAPES[kind];
    const mine = stills.filter((still) => still.kind === kind);
    assert.deepEqual(
      [...new Set(mine.map((still) => still.format))].sort(),
      [...shape.formats].sort(),
      kind,
    );
    for (const still of mine) {
      assert.equal(still.productId !== null, shape.perProduct, kind);
      assert.equal(still.colourway !== null, kind === "studio", kind);
    }
  }
});

test("each product's studio stills: every colourway once, the one it stands out on first", async () => {
  const given = await input();
  const stills = await drawAdStills(given);
  for (const one of given.products) {
    const studio = stills.filter(
      (still) => still.kind === "studio" && still.productId === one.productId,
    );
    const best = await studioColourwayFor(one.cutout);
    assert.equal(studio[0]!.colourway, best, one.productId);
    assert.deepEqual(
      studio.map((still) => still.colourway).sort(),
      [...PRODUCT_AD_STUDIO_COLOURWAYS].sort(),
    );
  }
  // The pale cup is shown on the warm evening sweep.
  assert.equal(
    stills.find((still) => still.kind === "studio" && still.productId === "p2")!
      .colourway,
    "night",
  );
});

test("only the default studio colourway, or only some kinds, when asked", async () => {
  const lazy = await drawAdStills(await input({ studio: "default" }));
  assert.equal(lazy.filter((still) => still.kind === "studio").length, 3);
  assert.equal(lazy.length, 3 * (1 + 1 + 2 + 1 + 1) + 4);
  const rooms = await drawAdStills(
    await input({ kinds: ["room", "collection"] }),
  );
  assert.deepEqual(
    rooms.map((still) => still.kind),
    ["room", "room", "room", "collection"],
  );
  assert.deepEqual(await drawAdStills(await input({ products: [] })), []);
});

test("one product, a phone number and a shop name the fonts can't draw: still every still, drawn whole", async () => {
  const given = await input({
    shopName: "🛍️",
    phone: "+0 000 000 00 00",
    sticker: "",
  });
  const stills = await drawAdStills({
    ...given,
    products: given.products.slice(0, 1),
  });
  assert.equal(stills.length, 1 + 5 + 2 + 1 + 1 + 4);
  assert.ok(stills.every((still) => still.image.length > 1000));
});

test("a still's file name is the contract's", () => {
  assert.equal(
    stillFileName(4, {
      kind: "studio",
      format: "feed",
      productId: "p1",
      colourway: "rose",
    }),
    "4-studio-feed-p1-rose.jpg",
  );
  assert.equal(
    stillFileName(4, {
      kind: "price_list",
      format: "story",
      productId: null,
      colourway: null,
    }),
    "4-price_list-story-all-x.jpg",
  );
  assert.deepEqual(studioOrder("sage"), [
    "sage",
    "white",
    "sand",
    "rose",
    "night",
  ]);
});

test("big price: the product never hides the digits, wide or tall; it stands in front of their foot, its name under it", async () => {
  for (const format of ["feed", "story"] as const)
    for (const priceText of ["500 ₸", "2 000 ₸", "15 500 ₸ бастап"])
      for (const cutout of [
        // A wide phone, a tall doll.
        { width: 1200, height: 700 },
        { width: 400, height: 900 },
      ]) {
        const layout = await bigPriceLayout(
          { name: "Телефон ойыншық", priceText },
          cutout,
          format,
          "#241e1a",
        );
        const label = `${format} ${priceText} ${cutout.width}x${cutout.height}`;
        // Only the digits' bottom 14% may be behind the product.
        assert.ok(
          layout.product.y >= layout.digits.y + layout.digits.h * 0.85,
          label,
        );
        // The name stays under the product, and inside the frame.
        assert.ok(
          layout.name.top >= layout.product.y + layout.product.h,
          label,
        );
        assert.ok(
          layout.name.top + layout.name.layer.height <= layout.frame.height,
          label,
        );
        // The "from" words sit above the amount.
        if (priceText.includes("бастап"))
          assert.ok(
            layout.small!.top + layout.small!.layer.height <= layout.amount.top,
            label,
          );
        else assert.equal(layout.small, null, label);
      }
  // A tall product reaches up in front of the digits' foot.
  const tall = await bigPriceLayout(
    { name: "Кукла", priceText: "5 000 ₸" },
    { width: 400, height: 900 },
    "story",
    "#241e1a",
  );
  assert.ok(
    tall.product.y < tall.digits.y + tall.digits.h,
    `${tall.product.y}`,
  );
});

const NB = "\u00a0";
const listInput = (
  products: Array<{ productId: string; name: string; priceText: string }>,
) => ({
  products: products.map((one) => ({
    ...one,
    caption: "",
    cutout: Buffer.alloc(0),
    picture: Buffer.alloc(0),
    box: null,
  })),
  priceCardTitle: "Барлығы бағасымен тұр",
  ending: "WhatsApp-қа жазып тапсырыс беріңіз",
  shopName: "Demo Shop",
  phone: null,
});
const listSizes = new Map([
  ["p1", { width: 400, height: 900 }],
  ["p2", { width: 1200, height: 700 }],
  ["p3", { width: 600, height: 600 }],
]);

test("price list: a long name wraps to two readable lines instead of shrinking away; a short one stays one line", async () => {
  const layout = await priceListLayout(
    listInput([
      {
        productId: "p1",
        name: "Балаларға арналған үлкен әдемі қуыршақ көк көйлекпен",
        priceText: `от 1${NB}500${NB}000${NB}₸`,
      },
      { productId: "p2", name: "Кружка", priceText: `500${NB}₸` },
      {
        productId: "p3",
        name: "Музыкалық ойыншық телефон жарықпен және дыбыспен",
        priceText: `12${NB}500${NB}₸ бастап`,
      },
    ]),
    listSizes,
  );
  const [long, short, wordsAfter] = layout.rows;
  assert.ok(long!.name.px >= PRICE_LIST_NAME_MIN_PX, `${long!.name.px}`);
  assert.ok(
    long!.name.layer.height > short!.name.layer.height * 1.6,
    "two lines",
  );
  assert.equal(short!.name.px, PRICE_LIST_NAME_PX);
  assert.ok(wordsAfter!.name.px >= PRICE_LIST_NAME_MIN_PX);
});

test("price list: rows stay in their band without touching, every price whole inside the safe area, the dots between name and price", async () => {
  for (const count of [1, 2, 3]) {
    const layout = await priceListLayout(
      listInput(
        [
          {
            productId: "p1",
            name: "Шежіре ағашы үлкен өлшемді",
            priceText: `15${NB}500${NB}₸ бастап`,
          },
          {
            productId: "p2",
            name: "Кукла Лол",
            priceText: `от 1${NB}500${NB}000${NB}₸`,
          },
          { productId: "p3", name: "Кружка", priceText: `500${NB}₸` },
        ].slice(0, count),
      ),
      listSizes,
    );
    assert.equal(layout.rows.length, count);
    const right = STORY_SAFE.x + STORY_SAFE.w;
    let previousBottom = layout.band.top;
    for (const row of layout.rows) {
      const top = Math.min(row.thumb.y, row.name.top);
      const bottom = Math.max(
        row.thumb.y + row.thumb.h,
        row.price.top + row.price.layer.height,
      );
      assert.ok(top >= previousBottom, `${count}: ${top} < ${previousBottom}`);
      assert.ok(bottom <= layout.band.bottom, `${count}: ${bottom}`);
      previousBottom = bottom;
      // The name over the price; both right of the picture, the price at the edge.
      assert.ok(row.price.top >= row.name.top + row.name.layer.height);
      assert.ok(row.name.left >= row.thumb.x + row.thumb.w);
      assert.ok(row.price.left + row.price.layer.width <= right);
      assert.ok(row.name.left + row.name.layer.width <= right);
      // The dots run from the name's edge to just before the price.
      assert.ok(row.leader, `${count}: leader`);
      assert.equal(row.leader!.left, row.name.left);
      assert.ok(row.leader!.left + row.leader!.width < row.price.left);
    }
    assert.ok(layout.shop!.top >= layout.band.bottom);
    assert.ok(layout.band.top >= layout.title.top + layout.title.layer.height);
  }
});

test("price list: the dots are level with the amount, whether its words sit above or under it; one product is centred", async () => {
  const layout = await priceListLayout(
    listInput([
      {
        productId: "p1",
        name: "Шежіре",
        priceText: `15${NB}500${NB}₸ бастап`,
      },
      {
        productId: "p2",
        name: "Кукла",
        priceText: `от 5${NB}000${NB}₸`,
      },
      { productId: "p3", name: "Кружка", priceText: `500${NB}₸` },
    ]),
    listSizes,
  );
  const share = (row: (typeof layout.rows)[number]) =>
    (row.leader!.top + 5 - row.price.top) / row.price.layer.height;
  const [after, before, plain] = layout.rows;
  assert.ok(share(after!) < 0.45, `words under: ${share(after!)}`);
  assert.ok(share(before!) > 0.55, `words above: ${share(before!)}`);
  assert.ok(Math.abs(share(plain!) - 0.5) < 0.05, `${share(plain!)}`);

  const one = await priceListLayout(
    listInput([{ productId: "p3", name: "Кружка", priceText: `500${NB}₸` }]),
    listSizes,
  );
  const row = one.rows[0]!;
  const middle = row.thumb.y + row.thumb.h / 2;
  const bandMiddle = (one.band.top + one.band.bottom) / 2;
  assert.ok(Math.abs(middle - bandMiddle) <= 2, `${middle} vs ${bandMiddle}`);
  // Alone, its picture is bigger than in a list of three.
  assert.ok(row.thumb.h > layout.rows[2]!.thumb.h);
});

test("spotlight: the product stands between its caption and its price tag inside the Story safe band", async () => {
  for (const caption of ["Балаңызға керемет сыйлық", ""])
    for (const cutout of [
      { width: 1200, height: 700 },
      { width: 400, height: 900 },
    ]) {
      const layout = await spotlightLayout(
        {
          name: "Шежіре ағашы үлкен өлшемді",
          caption,
          priceText: `15${NB}500${NB}₸ бастап`,
        },
        cutout,
        "#241e1a",
      );
      const wordsBottom = layout.caption
        ? layout.caption.top + layout.caption.layer.height
        : layout.name.top + layout.name.layer.height;
      assert.ok(layout.name.top >= STORY_SAFE.y);
      if (caption) {
        assert.ok(layout.caption);
        assert.ok(
          layout.caption.top >= layout.name.top + layout.name.layer.height,
        );
      } else {
        assert.equal(layout.caption, null);
      }
      assert.ok(layout.product.y >= wordsBottom);
      assert.ok(layout.product.y + layout.product.h <= layout.tag.top);
      assert.ok(
        layout.tag.top + layout.tag.layer.height <= STORY_SAFE.y + STORY_SAFE.h,
      );
    }
});

test("print: the photo and bottom mat words stay inside the paper print card without overlapping", async () => {
  const layout = await printLayout({
    name: "Балаларға арналған үлкен әдемі қуыршақ",
    caption: "Көк көйлек киген сүйкімді сыйлық",
    priceText: `15${NB}500${NB}₸ бастап`,
  });
  const cardRight = layout.card.x + layout.card.w;
  const cardBottom = layout.card.y + layout.card.h;
  assert.ok(layout.photo.x >= layout.card.x);
  assert.ok(layout.photo.y >= layout.card.y);
  assert.ok(layout.photo.x + layout.photo.w <= cardRight);
  assert.ok(layout.name.top >= layout.photo.y + layout.photo.h);
  assert.ok(layout.caption);
  assert.ok(layout.caption.top >= layout.name.top + layout.name.layer.height);
  assert.ok(layout.caption.top + layout.caption.layer.height <= cardBottom);
  assert.ok(layout.name.left + layout.name.layer.width < layout.price.left);
  assert.ok(
    layout.caption.left + layout.caption.layer.width < layout.price.left,
  );
  assert.ok(layout.price.left + layout.price.layer.width <= cardRight);
  assert.ok(layout.price.top + layout.price.layer.height <= cardBottom);
});

test("grid: 1, 2 or 3 products sit in non-overlapping paper cards between the title and WhatsApp pill", async () => {
  for (const format of ["feed", "story"] as const)
    for (const count of [1, 2, 3]) {
      const layout = await gridLayout(
        {
          ...listInput(
            [
              {
                productId: "p1",
                name: "Шежіре ағашы үлкен өлшемді",
                priceText: `15${NB}500${NB}₸ бастап`,
              },
              {
                productId: "p2",
                name: "Кукла Лол",
                priceText: `от 5${NB}000${NB}₸`,
              },
              { productId: "p3", name: "Кружка", priceText: `500${NB}₸` },
            ].slice(0, count),
          ),
          sticker: "Жаңа тауарлар",
        },
        listSizes,
        format,
      );
      assert.equal(layout.cells.length, count);
      assert.ok(
        layout.band.top >= layout.title.top + layout.title.layer.height,
      );
      assert.ok(layout.pill.top >= layout.band.bottom);
      for (const cell of layout.cells) {
        assert.ok(cell.card.y >= layout.band.top);
        assert.ok(cell.card.y + cell.card.h <= layout.band.bottom);
        assert.ok(cell.thumb.y >= cell.card.y);
        assert.ok(cell.name.top >= cell.thumb.y + cell.thumb.h);
        assert.ok(cell.price.top >= cell.name.top + cell.name.layer.height);
        assert.ok(
          cell.price.top + cell.price.layer.height <= cell.card.y + cell.card.h,
        );
      }
      if (count === 3) {
        const [first, second, third] = layout.cells;
        assert.equal(first!.card.y, second!.card.y);
        assert.ok(second!.card.x >= first!.card.x + first!.card.w);
        assert.ok(third!.card.y >= first!.card.y + first!.card.h);
        assert.ok(third!.card.x > first!.card.x);
      }
    }
});
