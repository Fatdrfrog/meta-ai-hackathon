// The ad's voices (Part V): the voice picker, the consent to clone the
// owner's voice, "Remove my voice", airi's voices and why a video fell back
// to the recording. Part of PRODUCTS_COPY (copy.ts). Owned by the voice
// stream; the brief's v1 voice words stay in copy-ad.ts (`ad.voices`).

import type {
  ProductAdVoiceFallback,
  ProductAdVoiceMode,
  ProductVoiceErrorCode,
} from "./types";

/** "3 Nov": the day a video came in, in the owner's English. */
export function voiceVideoDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export const VOICE_COPY = {
  adVoice: {
    title: "Voice",
    modes: {
      own: "Your recording",
      clone: "Your voice, new words",
      stock: "Airi voices",
      none: "No voice",
    } satisfies Record<ProductAdVoiceMode, string>,
    modeAbout: {
      clone:
        "Your voice reads new words Muse Spark wrote for each product, then the shelf price.",
      stock:
        "An Airi voice reads new words Muse Spark wrote for each product, then the shelf price.",
    },
    pricesByCode:
      "Prices are said from your shelf, written by code, and drawn on the video as before.",
    consentTitle: "Use your voice for new words?",
    consent:
      "This is my voice, or the person speaking agreed to have it cloned. Airi will make a copy of this voice with ElevenLabs to read your ad.",
    consentAbout:
      "Airi sends about a minute of your video's narration to ElevenLabs. The copy is kept for this workspace only, and you can remove it at any time.",
    /** The video the copy is made from, named before the tick. */
    sourceFrom: (day: string | null, names: readonly string[]) =>
      `${day ? `From your video of ${day}` : "From your video"}${names.length ? `, with ${names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ")}` : ""}.`,
    sourceLoading: "Finding the video your voice is copied from…",
    sourceFailed:
      "The video your voice would be copied from couldn't be found.",
    consentConfirm: "Copy my voice",
    consentCancel: "Not now",
    consentNeeded: "Tick the box to agree first.",
    copying: "Saving…",
    copyFailed: "Your agreement couldn't be saved. Try again.",
    noSource:
      "These products didn't come from one of your videos, so there's no voice to copy.",
    unavailable: "Voices aren't available right now. Try again later.",
    checking: "Checking your voice…",
    checkFailed: "Your voice couldn't be checked.",
    madeFrom: (date: string) => `Made from your video of ${date}`,
    madeFromUnknown: "Made from one of your videos",
    pending: (date: string | null) =>
      date
        ? `Copied from your video of ${date} when the ad is made.`
        : "Copied from your video when the ad is made.",
    remove: "Remove my voice",
    removeConfirm:
      "Remove your copied voice? Airi deletes it at ElevenLabs. Videos already made keep their sound.",
    removeYes: "Remove",
    removeNo: "Keep it",
    removing: "Removing…",
    removed: "Your voice was removed.",
    removeFailed:
      "Your voice couldn't be removed right now. Try again in a minute.",
    tryAgain: "Try again",
    tooLittle: (seconds: number | null) =>
      `Your video has ${seconds !== null ? `about ${Math.round(seconds)} s` : "too little"} of clear speech, and a copy needs at least 20 s. Film one where you talk for half a minute or more, or pick another voice.`,
    stockLegend: "Airi voice",
    playSample: "Play a sample",
    stopSample: "Stop",
    sampleLoading: "Loading…",
    sampleFailed: "This sample couldn't play.",
    samplesLoading: "Loading Airi's voices…",
    samplesFailed: "Airi's voices couldn't load.",
    // The finished ad's voice panel.
    now: "In the video",
    change: "Change the voice",
    apply: "Make the video with this voice",
    applying: "Starting…",
    cancel: "Cancel",
    costFree: "Free · no AI used",
    costPaid: (cents: number) =>
      `Reading new words costs about ${cents}¢ of AI on this ad`,
    costRecording: (cents: number) =>
      `Cleaning up your recording costs about ${cents}¢ of AI on this ad`,
    running: "Making the video with the new voice…",
    lastRunFailed:
      "The voice couldn't be changed. Your earlier video is still here.",
    sameVoice: "The video already has this voice.",
    refusals: {
      ad_not_ready: "Wait for the change being made to finish.",
      voice_not_found: "Copy your voice first.",
      spend_limit: "The company's AI spending limit has been reached.",
      trial_ended: "The free trial has ended.",
      ai_actions_used: "The plan's included AI actions are used up.",
      ai_disabled: "AI is turned off for your company.",
      failed: "The voice couldn't be changed. Try again.",
    },
    /** The consent refused because the company turned AI off. */
    consentAiDisabled:
      "AI is turned off for your company, so your voice can't be copied.",
    /** Why a video isn't in the voice asked for; `fellBackTo` says what it has instead. */
    fallbacks: {
      no_voice: "Your copied voice isn't there any more",
      unavailable: "The new voice couldn't be made",
      spend_refused: "This ad has no AI budget left for a new voice",
      price_unchecked: "A spoken price couldn't be checked against your shelf",
      too_long: "The new words were too long for the video",
    } satisfies Record<ProductAdVoiceFallback, string>,
    fellBackTo: {
      own: ", so the video uses your recording.",
      none: ", so the video has no voice.",
    },
    errors: {
      too_little_speech:
        "Your video has too little clear speech to copy your voice. Film a video where you talk for at least half a minute.",
      no_source: "The video your voice would be made from is gone.",
      clone_failed: "Your voice couldn't be copied. Try again in a minute.",
      spend_refused: "Your company's AI budget can't cover copying your voice.",
    } satisfies Record<ProductVoiceErrorCode, string>,
  },
} as const;
