import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PRODUCT_AD_SUPPORTED_RANGES,
  productAdLettersSupported,
} from "@icecore/temporal";
import sharp from "sharp";

import {
  AD_FONTS,
  adFontDescription,
  fontCodePoints,
  type AdFace,
  type AdWeight,
} from "./fonts";

// The glyph test: the ad's words are drawn by its bundled fonts alone, on a
// worker image without fonts of its own. A letter the fonts lack would come
// out as an empty box (Pango's .notdef "hex box"), or in some other font.

const SAMPLE = "Кукла Лол әғқңөұүһі ₸ 5 000";
const KAZAKH = "ӘәҒғҚқҢңӨөҰұҮүҺһІі";
const FACES: AdFace[] = ["display", "text"];

const codePoints = Object.fromEntries(
  FACES.map((face) => [
    face,
    fontCodePoints(readFileSync(AD_FONTS[face].file)),
  ]),
) as Record<AdFace, Set<number>>;

async function render(
  text: string,
  face: AdFace,
  weight: AdWeight = "regular",
) {
  const { data, info } = await sharp({
    text: {
      text,
      font: adFontDescription(face, weight, 64),
      fontfile: AD_FONTS[face].file,
      rgba: true,
      dpi: 72,
    },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) ink += data[i]!;
  return { width: info.width, height: info.height, ink, data };
}

test("both bundled fonts map every letter of the sample, Kazakh's included, and ₸", () => {
  for (const face of FACES) {
    const missing = [...(SAMPLE + KAZAKH)].filter(
      (char) => char !== " " && !codePoints[face].has(char.codePointAt(0)!),
    );
    assert.deepEqual(
      missing,
      [],
      `${AD_FONTS[face].family} lacks ${missing.join(" ")}`,
    );
  }
});

test("the letters gate allows only code points both fonts draw", () => {
  const notDrawn: string[] = [];
  for (const [from, to] of PRODUCT_AD_SUPPORTED_RANGES) {
    for (let code = from; code <= to; code++) {
      if (code === 0x0a) continue;
      for (const face of FACES)
        if (!codePoints[face].has(code))
          notDrawn.push(`${AD_FONTS[face].family} U+${code.toString(16)}`);
    }
  }
  assert.deepEqual(notDrawn, []);
  // And the gate agrees with its own ranges across the scripts it covers.
  for (let code = 0x20; code < 0x2200; code++) {
    const char = String.fromCodePoint(code);
    if (char.normalize("NFC") !== char) continue;
    if (productAdLettersSupported(char))
      for (const face of FACES)
        assert.ok(
          codePoints[face].has(code),
          `the gate allows U+${code.toString(16)}, which ${AD_FONTS[face].family} lacks`,
        );
  }
});

test("each letter of the sample renders as a glyph, not the .notdef box of a private-use code point", async () => {
  for (const face of FACES) {
    // U+E000 is in no font: it is drawn as the missing-glyph box.
    const missing = await render("", face);
    for (const char of new Set([...(SAMPLE.replaceAll(" ", "") + KAZAKH)])) {
      const glyph = await render(char, face);
      assert.ok(
        glyph.ink > 0,
        `${char} in ${AD_FONTS[face].family} has no ink`,
      );
      const sameBox =
        glyph.width === missing.width &&
        glyph.height === missing.height &&
        glyph.data.equals(missing.data);
      assert.ok(
        !sameBox,
        `${char} in ${AD_FONTS[face].family} is the missing-glyph box`,
      );
      assert.ok(
        glyph.width !== missing.width || glyph.height !== missing.height,
        `${char} in ${AD_FONTS[face].family} has the missing-glyph box's size`,
      );
    }
  }
});

test("the weights come from the variable fonts' named instances", async () => {
  for (const face of FACES) {
    const regular = await render(SAMPLE, face, "regular");
    const medium = await render(SAMPLE, face, "medium");
    const semibold = await render(SAMPLE, face, "semibold");
    assert.ok(
      medium.ink > regular.ink,
      `${face} Medium is not heavier than Regular`,
    );
    assert.ok(
      semibold.ink > medium.ink,
      `${face} SemiBold is not heavier than Medium`,
    );
  }
  assert.equal(
    adFontDescription("display", "semibold", 64.4),
    "Geologica SemiBold 64",
  );
  assert.equal(adFontDescription("text", "regular", 30), "Inter 30");
});
