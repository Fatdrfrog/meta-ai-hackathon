// The workspace's cloned voice and airi's voices for video ads (Part V): what
// the voice API answers and takes. Re-exported by types.ts, so the page and
// the API import it from there. Owned by the voice stream; only the ad's own
// voice fields (types-ad.ts) are shared.

import type {
  ProductShopWordsCode,
  ProductVoiceErrorCode,
  ProductVoiceState,
} from "@icecore/temporal";

export {
  productAdSpeechCode,
  PRODUCT_AD_VOICE_SAMPLE_TEXT,
  PRODUCT_VOICE_ERROR_CODES,
  PRODUCT_VOICE_MAX_SPEECH_SECONDS,
  PRODUCT_VOICE_MIN_SPEECH_SECONDS,
  PRODUCT_VOICE_STATES,
  type ProductVoiceErrorCode,
  type ProductVoiceState,
} from "@icecore/temporal";

/**
 * The workspace's cloned voice, as the voice picker shows it: pending until
 * the first ad in "Your voice, new words" makes it, ready, or failed with
 * why. A removed voice isn't shown.
 */
export type ProductVoiceRecord = {
  state: Exclude<ProductVoiceState, "removed">;
  /** The import whose narration it was (or will be) made from. */
  sourceImportId: string;
  /** When that video came in, for "Made from your video of <date>"; null when it's gone. */
  sourceVideoAt: string | null;
  /** The clear speech it was made from (or, before, about how much the video has), in seconds. */
  speechSeconds: number | null;
  /** Why it couldn't be made; null otherwise. */
  errorCode: ProductVoiceErrorCode | null;
  /** When the owner ticked that it's their voice, or that the speaker agreed. */
  consentAt: string;
  createdAt: string;
};

/**
 * The video a voice would be copied from, shown before the consent tick so
 * the owner agrees to the speaker they see: when it came in, and the
 * products it showed.
 */
export type ProductVoiceSource = {
  importId: string;
  /** When the video came in, for "From your video of <date>"; null when unknown. */
  sourceVideoAt: string | null;
  /** About how much speech its narration has, in seconds. */
  speechSeconds: number;
  /** The ad's products that came from it, by name. */
  productNames: string[];
};

/**
 * GET /products/voice: the workspace's voice; null when it has none (or
 * removed it). With ?productIds=, also the video a copy would be made from
 * (`source`; null when none of them came from a video).
 */
export type ProductVoiceResponse = {
  voice: ProductVoiceRecord | null;
  source?: ProductVoiceSource | null;
};

/**
 * POST /products/voice: clone the owner's voice from a video's narration,
 * only with the consent tick. The video is `importId`, or the one with the
 * most speech among the videos `productIds` came from. A workspace with a
 * voice already gets it back; a video with too little speech gets a failed
 * voice saying so (`errorCode` too_little_speech).
 */
export type ProductVoiceCreateRequest = {
  /** "This is my voice, or the person speaking agreed to have it cloned." */
  consent: true;
  importId?: string;
  productIds?: string[];
};

/** One Airi voice, with a link to its sample in the ad's language. */
export type ProductVoiceSample = {
  voiceId: string;
  name: string;
  about: string;
  /** GET …/voice/samples/<voiceId>?language=…: the sample, made once and kept. */
  url: string;
};

/** GET /products/voice/samples?language=…: the Airi voices, each with a sample. */
export type ProductVoiceSamplesResponse = {
  language: ProductShopWordsCode;
  samples: ProductVoiceSample[];
};
