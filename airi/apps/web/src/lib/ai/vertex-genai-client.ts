/**
 * Singleton `@google/genai` clients keyed by Vertex **location** (e.g. `global` for Gemini).
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/sdks/overview
 */

import "server-only";

import { GoogleGenAI } from "@google/genai";
import {
  getVertexGoogleAuthOptions,
  resolveVertexEmbeddingProjectId,
} from "./vertex-auth";
import { getVertexApiVersion, getVertexGeminiLocation } from "./vertex-env";

const vertexClientPromises = new Map<string, Promise<GoogleGenAI>>();

export async function getVertexGenAI(
  location = getVertexGeminiLocation()
): Promise<GoogleGenAI> {
  const normalizedLocation =
    String(location || "").trim() || getVertexGeminiLocation();
  const existingPromise = vertexClientPromises.get(normalizedLocation);
  if (existingPromise) {
    return existingPromise;
  }

  const clientPromise = (async () => {
    const project = await resolveVertexEmbeddingProjectId();
    if (!project) {
      throw new Error(
        "Vertex AI requires GOOGLE_CLOUD_PROJECT or ADC with a resolvable project."
      );
    }

    return new GoogleGenAI({
      vertexai: true,
      project,
      location: normalizedLocation,
      apiVersion: getVertexApiVersion(),
      googleAuthOptions: getVertexGoogleAuthOptions(),
    });
  })().catch(error => {
    vertexClientPromises.delete(normalizedLocation);
    throw error;
  });

  vertexClientPromises.set(normalizedLocation, clientPromise);
  return clientPromise;
}
