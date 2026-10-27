import "server-only";

/**
 * Web-owned code the creative image generation worker activity uses, in one
 * module, so the activity reaches the web app through a single import.
 */
export { default as connectDB } from "@/lib/mongoose";
export { CreativeAsset } from "@/models/creative-asset";
export * as creativeCredentials from "@/lib/google/creative-credentials";
export * as elevenLabsImageGeneration from "@/lib/elevenlabs/image-generation";
export * as googleCreativeAssets from "@/lib/google/creative-assets";
export {
  assertCreativeAssetAllowed,
  resolveCreativeAssetMimeType,
} from "@/lib/higgsfield/creative-asset-storage";
