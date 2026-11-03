import type {
  DraftProductRecord,
  ProductPhotoMethod,
  ProductVideoImportRecord,
} from "@/lib/products/types";
import {
  draftShelfInfo,
  formatElapsed,
  formatSentOf,
  formatVideoSize,
  importPercent,
  importPhase,
  latestMade,
  ledgerRows,
  newestLanded,
  photoTrail,
  pickHero,
  railNotes,
  railState,
  splitSentences,
  stageHead,
  stagePhotos,
  stageText,
  type StagePhoto,
} from "./product-stage-model";

// What an import's stage shows, worked out from the import and its products.

const record = (
  overrides: Partial<ProductVideoImportRecord> = {}
): ProductVideoImportRecord => ({
  id: "import-1",
  status: "processing",
  stage: "cutting",
  productTotal: 5,
  photoTotal: 5,
  photoDone: 2,
  errorCode: null,
  photosStopped: null,
  draftsLeft: true,
  presenter: null,
  createdAt: "2026-10-30T05:59:34.900Z",
  finishedAt: null,
  ...overrides,
});

type OptionSpec = {
  method: ProductPhotoMethod;
  description: string;
  imageUrl?: string | null;
  originalUrl?: string | null;
};

const product = (
  id: string,
  name: string,
  price: number | null,
  options: OptionSpec[],
  extra: Partial<DraftProductRecord> = {}
): DraftProductRecord => ({
  id,
  name,
  price,
  currency: price === null ? null : "KZT",
  priceIsFrom: false,
  imageUrl: options[0]?.imageUrl ?? null,
  updatedAt: null,
  status: "draft",
  englishName: null,
  nameSource: "spoken",
  priceQuote: null,
  priceSource: "spoken",
  doubts: [],
  options: options.map(option => ({
    description: option.description,
    photoMethod: option.method,
    imageUrl: option.imageUrl ?? null,
    photoUrl: null,
    originalUrl: option.originalUrl ?? null,
    videoMomentSeconds: null,
    straightenedDegrees: 0,
    notes: [],
  })),
  featuredOption: 0,
  clipUrl: null,
  ...extra,
});

const made = (description: string, n: number): OptionSpec => ({
  method: "restored",
  description,
  imageUrl: `https://storage.test/thumb-${n}.webp`,
  originalUrl: `https://storage.test/orig-${n}.jpg`,
});
const pending = (description: string): OptionSpec => ({
  method: "pending",
  description,
});

// The owner's first production run, 2026-10-30: five products, two photos
// made before the import stopped.
const todaysRun = () => [
  product("hl", "Holly Land", 40000, [
    made("black Hollyland charging case", 0),
  ]),
  product("ms", "Мышка", 20000, [pending("worn black wireless mouse")]),
  product("pc", "Печать", 2000, [made("green and black stamp", 2)]),
  product("st", "пачка стикеров", 5, [pending("yellow sticky notes pack")], {
    doubts: [{ about: "price", text: "5 tenge seems too low for a pack." }],
  }),
  product("nk", "наушники", 30000, [pending("white AirPods case with pink D")]),
];

const statesOf = (photos: StagePhoto[]) => photos.map(photo => photo.state);

describe("today's run", () => {
  test("while cutting, the three photos left are all being made", () => {
    expect(statesOf(stagePhotos(todaysRun(), record()))).toEqual([
      "made",
      "making",
      "made",
      "making",
      "making",
    ]);
  });

  test("after the failure, the photos never made say so instead of pulsing", () => {
    const failed = record({
      status: "failed",
      stage: null,
      errorCode: "spend_limit",
    });
    expect(statesOf(stagePhotos(todaysRun(), failed))).toEqual([
      "made",
      "unmade",
      "made",
      "unmade",
      "unmade",
    ]);
    const shelf = draftShelfInfo(todaysRun(), failed);
    expect([...shelf.values()].map(info => info.photo)).toEqual([
      "photo",
      "unmade",
      "photo",
      "unmade",
      "unmade",
    ]);
    expect(shelf.get("st")!.priceDoubt).toBe(true);
    expect(shelf.get("hl")!.priceDoubt).toBe(false);
    expect(stageText(failed, 5)).toEqual({
      label: "Airi reached an AI spending limit after 2 of 5 photos.",
      helper: "The products it found are kept for you to check.",
      alert: true,
      check: "found",
    });
  });

  test("when photos stopped, the import is ready and says why some are missing", () => {
    const stopped = record({
      status: "ready",
      stage: null,
      photosStopped: "spend_limit",
    });
    expect(statesOf(stagePhotos(todaysRun(), stopped))).toEqual([
      "made",
      "unmade",
      "made",
      "unmade",
      "unmade",
    ]);
    expect(stageText(stopped, 5)).toEqual({
      label: "5 products found. Check them before they go on your shelf.",
      helper:
        "3 photos weren't made because your company's AI spending limit was reached.",
      alert: false,
      check: "products",
    });
    expect(railState(stopped, null, true)).toEqual({
      current: "check",
      stopped: "photos",
    });
  });

  test("once photos stop, those left aren't shown as being made while the clips are cut", () => {
    const cuttingClips = record({ photosStopped: "spend_limit" });
    expect(statesOf(stagePhotos(todaysRun(), cuttingClips))).toEqual([
      "made",
      "unmade",
      "made",
      "unmade",
      "unmade",
    ]);
    expect(
      [...draftShelfInfo(todaysRun(), cuttingClips).values()].map(
        info => info.photo
      )
    ).toEqual(["photo", "unmade", "photo", "unmade", "unmade"]);
  });

  test("a free trial that ended stops the photos and says so", () => {
    expect(
      stageText(
        record({ status: "ready", stage: null, photosStopped: "trial_ended" }),
        5
      ).helper
    ).toBe("3 photos weren't made because your free trial has ended.");
  });

  test("the shelf's prompts come from each item's description", () => {
    const shelf = draftShelfInfo(todaysRun(), record());
    expect(shelf.get("ms")).toEqual({
      photo: "making",
      prompt: "worn black wireless mouse",
      priceDoubt: false,
    });
  });
});

describe("which photos are being made", () => {
  const sixPending = () =>
    Array.from({ length: 6 }, (_, n) =>
      product(`p${n}`, `Product ${n}`, 100, [pending(`item ${n}`)])
    );

  test("as many as the job makes at once, then the rest wait", () => {
    expect(statesOf(stagePhotos(sixPending(), record()))).toEqual([
      "making",
      "making",
      "making",
      "making",
      "waiting",
      "waiting",
    ]);
  });

  test("the next pending ones move up as photos land, in the order filmed", () => {
    const after = (landed: number[]) =>
      statesOf(
        stagePhotos(
          sixPending().map((item, n) =>
            landed.includes(n)
              ? product(item.id, item.name, 100, [made(`item ${n}`, n)])
              : item
          ),
          record()
        )
      );
    expect(after([])).toEqual([
      "making",
      "making",
      "making",
      "making",
      "waiting",
      "waiting",
    ]);
    expect(after([0])).toEqual([
      "made",
      "making",
      "making",
      "making",
      "making",
      "waiting",
    ]);
    // Out of order, as the job finishes them: the pool takes the next ones.
    expect(after([2])).toEqual([
      "making",
      "making",
      "made",
      "making",
      "making",
      "waiting",
    ]);
    expect(after([0, 1, 2, 3])).toEqual([
      "made",
      "made",
      "made",
      "made",
      "making",
      "making",
    ]);
  });

  test("nothing is made before cutting; a retry keeps the photos it has", () => {
    const products = [
      product("a", "A", 1, [made("red cup", 0)]),
      ...sixPending(),
    ];
    const resuming = record({ stage: "preparing", productTotal: 7 });
    expect(importPhase(resuming)).toBe("resuming");
    expect(statesOf(stagePhotos(products, resuming))).toEqual([
      "made",
      ...Array<string>(6).fill("waiting"),
    ]);
    expect(statesOf(stagePhotos(products, record()))).toEqual([
      "made",
      "making",
      "making",
      "making",
      "making",
      "waiting",
      "waiting",
    ]);
    // Watching, with the products just found: all still wait.
    expect(
      statesOf(stagePhotos(products, record({ stage: "watching" })))
    ).toEqual(["made", ...Array<string>(6).fill("waiting")]);
  });

  test("every option of a product is a photo; the shelf shows the featured one", () => {
    const panel = product(
      "panel",
      "Шежіре",
      15500,
      [
        made("dark wood family tree panel", 0),
        pending("light wood family tree panel"),
        pending("gold family tree panel"),
      ],
      { featuredOption: 1, imageUrl: null }
    );
    const photos = stagePhotos([panel], record());
    expect(
      photos.map(photo => [photo.key, photo.state, photo.featured])
    ).toEqual([
      ["panel:0", "made", false],
      ["panel:1", "making", true],
      ["panel:2", "making", false],
    ]);
    expect(draftShelfInfo([panel], record()).get("panel")).toMatchObject({
      photo: "making",
      prompt: "light wood family tree panel",
    });
  });

  test("each photo carries its product's price in the currency it was said in", () => {
    const [photo] = stagePhotos(
      [
        product("ps", "Phone stand", 10, [made("black phone stand", 0)], {
          currency: "USD",
          priceIsFrom: true,
        }),
      ],
      record()
    );
    expect(photo).toMatchObject({
      price: 10,
      currency: "USD",
      priceIsFrom: true,
    });
  });

  test("a published product's pending photo still takes a place in line", () => {
    const products = [
      product("pub", "Published", 1, [pending("blue cup")], {
        status: "published",
      }),
      ...sixPending(),
    ];
    expect(statesOf(stagePhotos(products, record()))).toEqual([
      "making",
      "making",
      "making",
      "making",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });
});

describe("a draft's place on the shelf", () => {
  test("an option with no files stands as its first letter", () => {
    const noFiles = product("x", "Блокнот", null, [
      { method: "none", description: "notebook" },
    ]);
    expect(draftShelfInfo([noFiles], record()).get("x")!.photo).toBe("initial");
    expect(stagePhotos([noFiles], record())[0]).toMatchObject({
      state: "made",
      method: "none",
      imageUrl: null,
    });
  });

  test("a whole frame, with no clear view, stands as a print", () => {
    const frame = product("f", "Frame", 1, [
      {
        method: "none",
        description: "mug",
        imageUrl: "https://storage.test/frame.webp",
      },
    ]);
    expect(draftShelfInfo([frame], record()).get("f")!.photo).toBe("print");
  });

  test("a product left without options by the photo cap stands as its letter", () => {
    const capped = product("c", "Capped", 1, []);
    expect(draftShelfInfo([capped], record()).get("c")!.photo).toBe("initial");
  });
});

describe("the stage's spotlight", () => {
  const photos = stagePhotos(todaysRun(), record());

  test("the newest photo made since last seen lifts off", () => {
    expect(newestLanded(new Set(), photos)?.key).toBe("pc:0");
    expect(newestLanded(new Set(["pc:0"]), photos)?.key).toBe("hl:0");
    expect(newestLanded(new Set(["hl:0", "pc:0"]), photos)).toBeNull();
  });

  test("the latest photo as filmed stands in when none landed in view", () => {
    expect(latestMade(photos)?.key).toBe("pc:0");
    expect(latestMade(photos, "originalUrl")?.originalUrl).toBe(
      "https://storage.test/orig-2.jpg"
    );
    expect(latestMade([])).toBeNull();
  });

  test("says how each photo was made, levelled and when in the video", () => {
    expect(
      photoTrail({
        method: "restored",
        straightenedDegrees: 0,
        momentSeconds: 7.4,
      })
    ).toBe(
      "Muse Spark found it, SAM 3.1 cut it out and Muse Image restored it. At 0:07 in your video."
    );
    expect(
      photoTrail({
        method: "tracked",
        straightenedDegrees: 36.6,
        momentSeconds: null,
      })
    ).toBe(
      "Muse Spark found it and SAM 3.1 cut it out as filmed. Levelled 37°."
    );
    expect(
      photoTrail({ method: "none", straightenedDegrees: 0, momentSeconds: 71 })
    ).toBe(
      "There was no clear view of it in the video. At 1:11 in your video."
    );
  });
});

test("formatElapsed reads m:ss, and h:mm:ss from an hour", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(42)).toBe("0:42");
  expect(formatElapsed(134.9)).toBe("2:14");
  expect(formatElapsed(3725)).toBe("1:02:05");
  expect(formatElapsed(-3)).toBe("0:00");
  expect(formatElapsed(Number.NaN)).toBe("0:00");
});

describe("importPercent", () => {
  test("follows the stages, then the photos", () => {
    expect(importPercent(record({ status: "queued", stage: null }))).toBe(1);
    const early = { productTotal: 0, photoTotal: 0, photoDone: 0 };
    expect(importPercent(record({ ...early, stage: "preparing" }))).toBe(2);
    expect(importPercent(record({ ...early, stage: "listening" }))).toBe(6);
    expect(importPercent(record({ ...early, stage: "watching" }))).toBe(12);
    expect(importPercent(record({ photoTotal: 3, photoDone: 1 }))).toBe(48);
    expect(importPercent(record({ status: "ready", stage: null }))).toBe(100);
  });

  test("never goes back: found products and a retry keep their place", () => {
    expect(
      importPercent(record({ stage: "watching", photoDone: 0, photoTotal: 5 }))
    ).toBe(22);
    expect(importPercent(record({ stage: "preparing", photoDone: 2 }))).toBe(
      53
    );
    const steps = [
      record({ status: "queued", stage: null, productTotal: 0, photoTotal: 0 }),
      record({ stage: "preparing", productTotal: 0, photoTotal: 0 }),
      record({ stage: "listening", productTotal: 0, photoTotal: 0 }),
      record({ stage: "watching", productTotal: 0, photoTotal: 0 }),
      record({ stage: "watching", photoDone: 0 }),
      record({ stage: "cutting", photoDone: 0 }),
      record({ stage: "cutting", photoDone: 2 }),
      record({ stage: "preparing", photoDone: 2 }),
      record({ stage: "cutting", photoDone: 5 }),
      record({ status: "ready", stage: null, photoDone: 5 }),
    ].map(importPercent);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});

describe("railState", () => {
  test.each([
    [record({ status: "queued", stage: null, productTotal: 0 }), "prepare"],
    [record({ stage: "preparing", productTotal: 0 }), "prepare"],
    [record({ stage: "listening", productTotal: 0 }), "listen"],
    [record({ stage: "watching", productTotal: 0 }), "watch"],
    [record({ stage: "cutting" }), "photos"],
    [record({ stage: "preparing" }), "photos"],
    [record({ status: "ready", stage: null }), "check"],
  ] as const)("%#: the current step", (state, current) => {
    expect(railState(state, null, true)).toEqual({ current, stopped: null });
  });

  test("a failure marks where it stopped; with drafts, checking them comes next", () => {
    const failed = record({
      status: "failed",
      stage: null,
      errorCode: "failed",
    });
    expect(railState(failed, "cutting", true)).toEqual({
      current: "check",
      stopped: "photos",
    });
    const early = { ...failed, productTotal: 0, photoTotal: 0, photoDone: 0 };
    expect(railState(early, "listening", false)).toEqual({
      current: "listen",
      stopped: "listen",
    });
    // Without the stage seen, the error tells.
    expect(
      railState({ ...early, errorCode: "video_unreadable" }, null, false)
    ).toEqual({ current: "prepare", stopped: "prepare" });
    expect(railState(early, null, false)).toEqual({
      current: "watch",
      stopped: "watch",
    });
  });

  test("an AI allowance that couldn't pay marks where it stopped", () => {
    const early = record({
      status: "failed",
      stage: null,
      productTotal: 0,
      photoTotal: 0,
      photoDone: 0,
    });
    // No stage seen: refused before the video was fetched, not after
    // listening.
    for (const errorCode of [
      "spend_limit",
      "ai_actions_used",
      "trial_ended",
    ] as const)
      expect(railState({ ...early, errorCode }, null, false)).toEqual({
        current: "prepare",
        stopped: "prepare",
      });
    // Seen watching: the video's reading was refused.
    expect(
      railState({ ...early, errorCode: "ai_actions_used" }, "watching", false)
    ).toEqual({ current: "watch", stopped: "watch" });
    // A video error is always at the start, whatever stage was seen last.
    expect(
      railState({ ...early, errorCode: "video_missing" }, "cutting", false)
    ).toEqual({ current: "prepare", stopped: "prepare" });
    // An earlier import the limit stopped after finding its products.
    expect(
      railState(
        record({ status: "failed", stage: null, errorCode: "spend_limit" }),
        null,
        true
      )
    ).toEqual({ current: "check", stopped: "photos" });
  });
});

describe("stageText", () => {
  test("each running step says what it's doing, not one line for all", () => {
    const helperAt = (overrides: Partial<ProductVideoImportRecord>) =>
      stageText(record(overrides), null).helper;
    const early = { productTotal: 0, photoTotal: 0, photoDone: 0 };
    expect(helperAt({ status: "queued", stage: null, ...early })).toBe(
      "Your video is next in line."
    );
    expect(helperAt({ stage: "preparing", ...early })).toBe(
      "Getting your video ready to read."
    );
    expect(helperAt({ stage: "listening", ...early })).toBe(
      "Writing down each name and price you said."
    );
    expect(helperAt({ stage: "watching", ...early })).toBe(
      "Spotting each product you showed."
    );
    expect(helperAt({ stage: "cutting" })).toBe(
      "Cutting out each product and cleaning its photo."
    );
    // A retry keeps what it had.
    expect(helperAt({ stage: "preparing" })).toBe(
      "The products and photos already made are kept."
    );
  });

  test("a failure with nothing found explains itself", () => {
    expect(
      stageText(
        record({
          status: "failed",
          stage: null,
          productTotal: 0,
          errorCode: "video_unreadable",
        }),
        null
      )
    ).toMatchObject({
      label:
        "This video couldn't be read. Try an MP4 or MOV straight from your phone's camera.",
      alert: true,
      check: null,
    });
  });

  test("a video that couldn't be read never claims products were kept", () => {
    // Its products haven't loaded yet: the count alone must not decide.
    const unreadable = record({
      status: "failed",
      stage: null,
      errorCode: "video_unreadable",
    });
    expect(stageText(unreadable, null)).toMatchObject({
      label:
        "This video couldn't be read. Try an MP4 or MOV straight from your phone's camera.",
      check: null,
    });
    expect(railState(unreadable, null, false)).toEqual({
      current: "prepare",
      stopped: "prepare",
    });
  });

  test("a failure after every photo, or before any", () => {
    const failed = record({
      status: "failed",
      stage: null,
      errorCode: "failed",
    });
    expect(stageText({ ...failed, photoDone: 5 }, 5).label).toBe(
      "Something went wrong after the photos were made."
    );
    expect(stageText({ ...failed, photoDone: 0 }, 5).label).toBe(
      "Something went wrong before any photos were made."
    );
    // Its products were all checked: nothing left to offer, and it still
    // says where it stopped, not that the video couldn't be read.
    expect(stageText(failed, 0)).toEqual({
      label: "Something went wrong after 2 of 5 photos.",
      helper: null,
      alert: true,
      check: null,
    });
    const limited = { ...failed, errorCode: "spend_limit" as const };
    for (const text of [
      stageText(limited, 0),
      stageText({ ...limited, draftsLeft: false }, null),
    ]) {
      expect(text).toEqual({
        label: "Airi reached an AI spending limit after 2 of 5 photos.",
        helper: null,
        alert: true,
        check: null,
      });
      expect(text.label).not.toMatch(/couldn't be read/);
    }
  });

  test("products left to check are offered, whatever stopped the import later", () => {
    // A retry found the video gone after the first attempt found products.
    const missing = record({
      status: "failed",
      stage: null,
      productTotal: 3,
      photoTotal: 3,
      photoDone: 1,
      errorCode: "video_missing",
    });
    expect(stageText(missing, 3)).toEqual({
      label: "The uploaded video went missing. Upload it again.",
      helper: "The products it found are kept for you to check.",
      alert: true,
      check: "found",
    });
    // Until they load, the error alone doesn't claim any were kept.
    expect(stageText(missing, null).check).toBeNull();
  });

  test("a free trial that ended before anything was found says so", () => {
    expect(
      stageText(
        record({
          status: "failed",
          stage: null,
          productTotal: 0,
          photoTotal: 0,
          photoDone: 0,
          errorCode: "trial_ended",
          draftsLeft: false,
        }),
        null
      )
    ).toEqual({
      label: "Your free trial has ended, so this video couldn't be read.",
      helper: null,
      alert: true,
      check: null,
    });
  });

  test("a ready import whose products were all checked offers nothing more", () => {
    expect(stageText(record({ status: "ready", stage: null }), 0)).toEqual({
      label: "Nothing is left to check in this video.",
      helper: null,
      alert: false,
      check: null,
    });
  });
});

test("the stage goes to the first import running, else the first to check", () => {
  const failed = record({ id: "f", status: "failed", productTotal: 0 });
  const ready = record({ id: "r", status: "ready", stage: null });
  const running = record({ id: "run" });
  const nothing = record({ id: "n", status: "ready", productTotal: 0 });
  expect(pickHero([failed, ready, running])?.id).toBe("run");
  expect(pickHero([failed, nothing, ready])?.id).toBe("r");
  expect(pickHero([record({ id: "fd", status: "failed" }), ready])?.id).toBe(
    "fd"
  );
  expect(pickHero([failed, nothing])).toBeNull();
});

test("an import whose products were all checked leaves the stage", () => {
  const checked = record({
    id: "checked",
    status: "failed",
    stage: null,
    errorCode: "spend_limit",
    draftsLeft: false,
  });
  const older = record({ id: "older", status: "ready", stage: null });
  expect(pickHero([checked, older])?.id).toBe("older");
  expect(pickHero([checked])).toBeNull();
  expect(
    pickHero([{ ...older, id: "all-added", draftsLeft: false }])
  ).toBeNull();
});

describe("stageHead", () => {
  test("making photos counts them; other running steps say what they do", () => {
    expect(stageHead(record(), null)).toEqual({
      title: "Making photos",
      lines: ["2 of 5 photos are made."],
      alert: false,
      check: null,
    });
    expect(
      stageHead(record({ photoTotal: 1, photoDone: 0, productTotal: 1 }), null)
        .lines
    ).toEqual(["0 of 1 photo is made."]);
    const early = { productTotal: 0, photoTotal: 0, photoDone: 0 };
    expect(stageHead(record({ stage: "listening", ...early }), null)).toEqual({
      title: "Listening to what you said",
      lines: ["Writing down each name and price you said."],
      alert: false,
      check: null,
    });
    expect(
      stageHead(record({ status: "queued", stage: null, ...early }), null)
    ).toMatchObject({
      title: "Getting ready to read your video",
      lines: ["Your video is next in line."],
    });
  });

  test("once photos stop, the clips still being cut don't count them on", () => {
    expect(stageHead(record({ photosStopped: "spend_limit" }), null)).toEqual({
      title: "Making photos",
      lines: [
        "3 photos weren't made because your company's AI spending limit was reached.",
      ],
      alert: false,
      check: null,
    });
  });

  test("a finished import names what it found, then what to do next", () => {
    expect(stageHead(record({ status: "ready", stage: null }), 5)).toEqual({
      title: "5 products found",
      lines: ["Check them before they go on your shelf."],
      alert: false,
      check: "products",
    });
    // Until its products load, the list's count stands in.
    expect(
      stageHead(record({ status: "ready", stage: null, productTotal: 1 }), null)
    ).toMatchObject({
      title: "1 product found",
      lines: ["Check it before it goes on your shelf."],
    });
    // Photos that stopped are said after.
    expect(
      stageHead(
        record({ status: "ready", stage: null, photosStopped: "trial_ended" }),
        5
      ).lines
    ).toEqual([
      "Check them before they go on your shelf.",
      "3 photos weren't made because your free trial has ended.",
    ]);
  });

  test("a failure keeps its sentence, and offers what it found", () => {
    const failed = record({
      status: "failed",
      stage: null,
      errorCode: "spend_limit",
    });
    expect(stageHead(failed, 5)).toEqual({
      title: "Airi reached an AI spending limit after 2 of 5 photos.",
      lines: ["The products it found are kept for you to check."],
      alert: true,
      check: "found",
    });
    expect(stageHead({ ...failed, draftsLeft: false }, 0)).toEqual({
      title: "Airi reached an AI spending limit after 2 of 5 photos.",
      lines: [],
      alert: true,
      check: null,
    });
    expect(
      stageHead(
        record({
          status: "ready",
          stage: null,
          productTotal: 0,
          photoTotal: 0,
          photoDone: 0,
        }),
        null
      )
    ).toEqual({
      title: "No products were found in this video.",
      lines: [
        "Film your shelf again, saying each product's name and price, with the currency at least once.",
      ],
      alert: false,
      check: null,
    });
  });

  test("what went wrong is the title; what to do, the line under it", () => {
    const unreadable = record({
      status: "failed",
      stage: null,
      productTotal: 0,
      photoTotal: 0,
      photoDone: 0,
      errorCode: "video_unreadable",
      draftsLeft: false,
    });
    expect(stageHead(unreadable, null)).toEqual({
      title: "This video couldn't be read.",
      lines: ["Try an MP4 or MOV straight from your phone's camera."],
      alert: true,
      check: null,
    });
    // Products kept after it: said after what to do.
    expect(
      stageHead(
        record({ status: "failed", stage: null, errorCode: "video_missing" }),
        2
      )
    ).toEqual({
      title: "The uploaded video went missing.",
      lines: [
        "Upload it again.",
        "The products it found are kept for you to check.",
      ],
      alert: true,
      check: "found",
    });
  });
});

test("splitSentences keeps a title to what happened", () => {
  expect(
    splitSentences(
      "The video was uploaded, but reading it couldn't start. Try again."
    )
  ).toEqual([
    "The video was uploaded, but reading it couldn't start.",
    "Try again.",
  ]);
  // A size or a model name never ends a sentence.
  expect(
    splitSentences(
      "The video is larger than 2 GB. Film a shorter one and upload it."
    )
  ).toEqual([
    "The video is larger than 2 GB.",
    "Film a shorter one and upload it.",
  ]);
  expect(splitSentences("Muse Spark 1.3 and SAM 3.1 worked.")).toEqual([
    "Muse Spark 1.3 and SAM 3.1 worked.",
    null,
  ]);
  expect(
    splitSentences("Your free trial has ended, so this video couldn't be read.")
  ).toEqual([
    "Your free trial has ended, so this video couldn't be read.",
    null,
  ]);
});

describe("railNotes", () => {
  test("the step making photos counts them", () => {
    const making = record();
    expect(railNotes(making, railState(making, null, true))).toEqual({
      counts: { photos: "2 of 5" },
      results: { watch: "5 products found" },
    });
  });

  test("steps behind say what they came to; nothing before it's known", () => {
    const ready = record({ status: "ready", stage: null, photoDone: 5 });
    expect(railNotes(ready, railState(ready, null, true))).toEqual({
      counts: {},
      results: { watch: "5 products found", photos: "5 of 5" },
    });
    const watching = record({
      stage: "watching",
      productTotal: 0,
      photoTotal: 0,
      photoDone: 0,
    });
    expect(railNotes(watching, railState(watching, null, true))).toEqual({
      counts: {},
      results: {},
    });
  });

  test("where photos stopped, it says how many were made", () => {
    const failed = record({
      status: "failed",
      stage: null,
      errorCode: "spend_limit",
    });
    expect(railNotes(failed, railState(failed, "cutting", true))).toEqual({
      counts: {},
      results: { watch: "5 products found", photos: "2 of 5" },
    });
    // With nothing left to check, the stop is the current step.
    expect(railNotes(failed, railState(failed, "cutting", false))).toEqual({
      counts: { photos: "2 of 5" },
      results: { watch: "5 products found" },
    });
  });
});

describe("ledgerRows", () => {
  const heard = (
    extra: Partial<DraftProductRecord>,
    option: OptionSpec = made("frosted cup", 0)
  ) => product("cup", "Кружка Web UMN", 500, [option], extra);

  test("each product's words, name, price and photo, in the order filmed", () => {
    const products = [
      heard({ priceQuote: "мына кружка бес жүз теңге" }),
      product("doll", "Кукла Лол", 5000, [pending("blue doll")], {
        priceQuote: "кукла бес мың",
        priceIsFrom: true,
        doubts: [{ about: "price", text: "Did you mean 5 000?" }],
      }),
    ];
    products[0]!.options[0]!.videoMomentSeconds = 2.4;
    expect(ledgerRows(products, stagePhotos(products, record()))).toEqual([
      {
        key: "cup",
        moment: 2.4,
        quote: "мына кружка бес жүз теңге",
        onScreen: false,
        name: "Кружка Web UMN",
        price: "500\u00a0₸",
        priceDoubt: false,
        photo: "made",
      },
      {
        key: "doll",
        moment: null,
        quote: "кукла бес мың",
        onScreen: false,
        name: "Кукла Лол",
        price: "from\u00a05\u00a0000\u00a0₸",
        priceDoubt: true,
        photo: "making",
      },
    ]);
  });

  test("words read on screen are marked, never passed off as heard", () => {
    const products = [
      heard({ priceQuote: "500 ₸", priceSource: "on_screen" }),
      heard({ priceQuote: null, priceSource: "on_screen", price: null }),
    ];
    const rows = ledgerRows(products, stagePhotos(products, record()));
    expect(rows.map(row => [row.quote, row.onScreen, row.price])).toEqual([
      ["500 ₸", true, "500\u00a0₸"],
      [null, false, null],
    ]);
  });

  test("a photo that couldn't be cut out, or never was, says so", () => {
    const products = [
      product("frame", "Frame", 1, [
        {
          method: "none",
          description: "mug",
          imageUrl: "https://storage.test/frame.webp",
        },
      ]),
      product("capped", "Capped", 1, []),
      ...todaysRun().slice(1, 2),
    ];
    const failed = record({
      status: "failed",
      stage: null,
      errorCode: "spend_limit",
    });
    expect(
      ledgerRows(products, stagePhotos(products, failed)).map(row => row.photo)
    ).toEqual(["noView", "unmade", "unmade"]);
    // Next in line while the job makes others.
    const many = Array.from({ length: 6 }, (_, n) =>
      product(`p${n}`, `P${n}`, 1, [pending(`item ${n}`)])
    );
    expect(
      ledgerRows(many, stagePhotos(many, record())).map(row => row.photo)
    ).toEqual(["making", "making", "making", "making", "waiting", "waiting"]);
  });
});

test("a video's size and how much of it is sent read in one unit", () => {
  expect(formatVideoSize(43 * 1024 * 1024)).toBe("43 MB");
  expect(formatVideoSize(4.53 * 1024 * 1024)).toBe("4.5 MB");
  expect(formatVideoSize(1.24 * 1024 ** 3)).toBe("1.2 GB");
  expect(formatVideoSize(2048)).toBe("2 KB");
  expect(formatSentOf(18.4 * 1024 * 1024, 43 * 1024 * 1024)).toBe(
    "18 of 43 MB"
  );
  expect(formatSentOf(0, 43 * 1024 * 1024)).toBe("0 of 43 MB");
  expect(formatSentOf(0.4 * 1024 ** 3, 1.2 * 1024 ** 3)).toBe("0.4 of 1.2 GB");
  // Never more than all of it.
  expect(formatSentOf(50 * 1024 * 1024, 43 * 1024 * 1024)).toBe("43 of 43 MB");
});
