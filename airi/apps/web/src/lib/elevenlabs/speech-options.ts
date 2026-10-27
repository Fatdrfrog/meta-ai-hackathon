import { normalizeProductLanguageBase } from "@/lib/airi/language-detector";

const KAZAKH_UNSUPPORTED_MODELS = new Set([
  "eleven_monolingual_v1",
  "eleven_multilingual_v1",
  "eleven_multilingual_v2",
  "eleven_turbo_v2",
  "eleven_turbo_v2_5",
  "eleven_flash_v2",
  "eleven_flash_v2_5",
]);

export function resolveElevenLabsSpeechOptions(options: {
  language?: string | null;
  modelId?: string | null;
}) {
  const productLanguage = normalizeProductLanguageBase(options.language);
  const languageCode = productLanguage === "kz" ? "kk" : productLanguage;
  const modelId =
    options.modelId?.trim() ||
    (languageCode === "kk" ? "eleven_v3" : "eleven_multilingual_v2");

  if (languageCode === "kk" && KAZAKH_UNSUPPORTED_MODELS.has(modelId)) {
    throw new Error(
      `ElevenLabs model ${modelId} does not support Kazakh. Use a Kazakh-capable model such as eleven_v3.`
    );
  }

  return { productLanguage, languageCode, modelId };
}
