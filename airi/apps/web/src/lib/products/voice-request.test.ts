import { PRODUCT_AD_STOCK_VOICES } from "@/lib/products/types";
import {
  parseProductAdVoiceRequest,
  parseProductVoiceCreateRequest,
  parseProductVoiceSourceQuery,
  parseVoiceSampleLanguage,
} from "./voice-request";

const DOLL = "651f1f77bcf86cd799439011";
const IMPORT = "551F1F77BCF86CD799439021";
const STOCK = PRODUCT_AD_STOCK_VOICES[0]!.id;

describe("the consent to clone a voice", () => {
  it("takes the tick with a video or the products it's from", () => {
    expect(
      parseProductVoiceCreateRequest({ consent: true, importId: IMPORT })
    ).toEqual({
      consent: true,
      importId: IMPORT.toLowerCase(),
    });
    expect(
      parseProductVoiceCreateRequest({
        consent: true,
        productIds: [DOLL, DOLL],
      })
    ).toEqual({ consent: true, productIds: [DOLL] });
  });

  it("says the consent is missing without exactly true", () => {
    for (const consent of [undefined, false, "true", 1])
      expect(
        parseProductVoiceCreateRequest({ consent, importId: IMPORT })
      ).toBe("missing_consent");
  });

  it("refuses anything else", () => {
    expect(parseProductVoiceCreateRequest(null)).toBeNull();
    expect(parseProductVoiceCreateRequest([])).toBeNull();
    expect(parseProductVoiceCreateRequest({ consent: true })).toBeNull();
    expect(
      parseProductVoiceCreateRequest({ consent: true, importId: "x" })
    ).toBeNull();
    expect(
      parseProductVoiceCreateRequest({
        consent: true,
        importId: IMPORT,
        productIds: [DOLL],
      })
    ).toBeNull();
    expect(
      parseProductVoiceCreateRequest({ consent: true, productIds: [] })
    ).toBeNull();
    expect(
      parseProductVoiceCreateRequest({
        consent: true,
        productIds: [DOLL, DOLL, DOLL, DOLL],
      })
    ).toBeNull();
    expect(
      parseProductVoiceCreateRequest({
        consent: true,
        importId: IMPORT,
        voiceId: "x",
      })
    ).toBeNull();
  });
});

describe("the products a copy's video is looked up for", () => {
  it("takes 1 to 3 product ids, once each, and nothing without the parameter", () => {
    expect(parseProductVoiceSourceQuery(null)).toBeUndefined();
    expect(
      parseProductVoiceSourceQuery(`${DOLL},${DOLL.toUpperCase()}`)
    ).toEqual([DOLL]);
    expect(parseProductVoiceSourceQuery("")).toBeNull();
    expect(parseProductVoiceSourceQuery(`${DOLL},nope`)).toBeNull();
    expect(
      parseProductVoiceSourceQuery(Array(4).fill(DOLL).join(","))
    ).toBeNull();
  });
});

describe("an ad's new voice", () => {
  it("takes a mode, and an Airi voice only with stock", () => {
    expect(
      parseProductAdVoiceRequest({ requestId: " r1 ", voice: "clone" })
    ).toEqual({
      requestId: "r1",
      voice: "clone",
    });
    expect(
      parseProductAdVoiceRequest({
        requestId: "r1",
        voice: "stock",
        stockVoiceId: STOCK,
      })
    ).toEqual({ requestId: "r1", voice: "stock", stockVoiceId: STOCK });
    expect(
      parseProductAdVoiceRequest({
        requestId: "r1",
        voice: "none",
        stockVoiceId: null,
      })
    ).toEqual({ requestId: "r1", voice: "none" });
  });

  it("carries the workbench's picks as PATCH takes them, and refuses changes that aren't", () => {
    expect(
      parseProductAdVoiceRequest({
        requestId: "r1",
        voice: "none",
        changes: { sticker: "  New   opening " },
      })
    ).toEqual({
      requestId: "r1",
      voice: "none",
      changes: { sticker: "New opening" },
    });
    expect(
      parseProductAdVoiceRequest({
        requestId: "r1",
        voice: "stock",
        stockVoiceId: STOCK,
        changes: { motion: "float" },
      })
    ).toEqual({
      requestId: "r1",
      voice: "stock",
      stockVoiceId: STOCK,
      changes: { motion: "float" },
    });
    expect(
      parseProductAdVoiceRequest({ requestId: "r1", voice: "own", changes: {} })
    ).toBeNull();
    expect(
      parseProductAdVoiceRequest({
        requestId: "r1",
        voice: "own",
        changes: { junk: 1 },
      })
    ).toBeNull();
  });

  it("refuses an unknown voice, a stock without one of airi's, and stray keys", () => {
    expect(
      parseProductAdVoiceRequest({ requestId: "r1", voice: "robot" })
    ).toBeNull();
    expect(
      parseProductAdVoiceRequest({ requestId: "r1", voice: "stock" })
    ).toBeNull();
    expect(
      parseProductAdVoiceRequest({
        requestId: "r1",
        voice: "stock",
        stockVoiceId: "someone",
      })
    ).toBeNull();
    expect(
      parseProductAdVoiceRequest({
        requestId: "r1",
        voice: "own",
        stockVoiceId: STOCK,
      })
    ).toBeNull();
    expect(parseProductAdVoiceRequest({ voice: "own" })).toBeNull();
    expect(
      parseProductAdVoiceRequest({ requestId: "x".repeat(65), voice: "own" })
    ).toBeNull();
    expect(
      parseProductAdVoiceRequest({ requestId: "r1", voice: "own", extra: 1 })
    ).toBeNull();
  });
});

describe("a sample's language", () => {
  it("is a shop language, English without one", () => {
    expect(parseVoiceSampleLanguage("kk")).toBe("kk");
    expect(parseVoiceSampleLanguage(null)).toBe("en");
    expect(parseVoiceSampleLanguage("")).toBe("en");
    expect(parseVoiceSampleLanguage("uz")).toBeNull();
  });
});
