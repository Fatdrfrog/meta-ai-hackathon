import { NextResponse } from "next/server";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { encryptString } from "@/lib/crypto";
import {
  GOOGLE_AI_SOURCE_TYPE,
  GoogleAiConnectionError,
  normalizeGoogleAiApiKey,
  toPublicGoogleAiCredentials,
  validateGoogleAiApiKey,
} from "@/lib/google/google-ai-source";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import type { GoogleAiCredentials } from "@icecore/shared/types/sources";

type Context = { params: Promise<{ workspaceId: string }> };
const headers = { "Cache-Control": "no-store" };

function failure(code: string, error: string, status = 500) {
  return NextResponse.json({ code, error }, { status, headers });
}

export async function PUT(request: Request, { params }: Context) {
  try {
    const { workspaceId } = await params;
    const access = await getAuthenticatedWorkspaceMembership(workspaceId);
    if (access.error) return access.error;
    const { supabase } = access;

    let apiKey: string;
    try {
      const body = await readJsonBodyWithinLimit(request, 8192);
      apiKey = normalizeGoogleAiApiKey(asNullableRecord(body)?.apiKey);
    } catch (error) {
      if (error instanceof JsonBodyTooLargeError) {
        return failure("INVALID_API_KEY", "The API key is too long.", 413);
      }
      if (
        error instanceof InvalidJsonBodyError ||
        error instanceof GoogleAiConnectionError
      ) {
        return failure(
          "INVALID_API_KEY",
          "Enter a valid Google AI API key.",
          400
        );
      }
      throw error;
    }

    // Encrypt before any provider request: do not accept a key we cannot store safely.
    let encryptedKey: ReturnType<typeof encryptString>;
    try {
      encryptedKey = encryptString(apiKey);
    } catch {
      return failure(
        "ENCRYPTION_UNAVAILABLE",
        "Secure credential storage is unavailable. Please try again later.",
        503
      );
    }

    const [{ data: workspace, error: workspaceError }, existing] =
      await Promise.all([
        supabase
          .from("workspaces")
          .select("company_id")
          .eq("id", workspaceId)
          .single(),
        supabase
          .from("sources")
          .select("id, credentials")
          .eq("workspace_id", workspaceId)
          .eq("type", GOOGLE_AI_SOURCE_TYPE)
          .maybeSingle(),
      ]);
    if (workspaceError || !workspace?.company_id || existing.error) {
      return failure(
        "SOURCE_SAVE_FAILED",
        "Could not load the Google AI connection. Please try again."
      );
    }

    const { modelCount } = await validateGoogleAiApiKey(apiKey);
    const now = new Date().toISOString();
    const current = toPublicGoogleAiCredentials(existing.data?.credentials);
    const credentials: GoogleAiCredentials = {
      api_key: encryptedKey,
      key_label: apiKey.length > 8 ? `****${apiKey.slice(-4)}` : "****",
      connected_at:
        typeof current.connected_at === "string" ? current.connected_at : now,
      validated_at: now,
      model_count: modelCount,
    };

    const result = existing.data?.id
      ? await supabase
          .from("sources")
          .update({ credentials })
          .eq("id", existing.data.id)
          .eq("workspace_id", workspaceId)
          .eq("type", GOOGLE_AI_SOURCE_TYPE)
          .eq("credentials", JSON.stringify(existing.data.credentials))
          .select("*")
          .single()
      : await supabase
          .from("sources")
          .insert({
            name: "Google AI (Gemini)",
            type: GOOGLE_AI_SOURCE_TYPE,
            workspace_id: workspaceId,
            company_id: workspace.company_id,
            credentials,
          })
          .select("*")
          .single();

    if (result.error || !result.data) {
      if (
        result.error?.code === "23505" ||
        (existing.data?.id &&
          ((!result.error && !result.data) ||
            result.error?.code === "PGRST116"))
      ) {
        return failure(
          "SOURCE_SAVE_CONFLICT",
          "This connection changed while the key was being checked. Refresh and try again.",
          409
        );
      }
      return failure(
        "SOURCE_SAVE_FAILED",
        "Could not save the Google AI connection. Refresh and try again.",
        500
      );
    }
    return NextResponse.json(
      {
        success: true,
        source: {
          ...result.data,
          credentials: toPublicGoogleAiCredentials(result.data.credentials),
        },
      },
      { headers }
    );
  } catch (error) {
    if (error instanceof GoogleAiConnectionError) {
      const status =
        error.code === "GOOGLE_AI_RATE_LIMITED"
          ? 429
          : error.code === "GOOGLE_AI_UNAVAILABLE" ||
              error.code === "GOOGLE_AI_INVALID_RESPONSE"
            ? 503
            : 400;
      return failure(error.code, error.message, status);
    }
    return failure(
      "SOURCE_SAVE_FAILED",
      "Could not save the Google AI connection. Please try again."
    );
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const { workspaceId } = await params;
    const access = await getAuthenticatedWorkspaceMembership(workspaceId);
    if (access.error) return access.error;
    const { error } = await access.supabase
      .from("sources")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("type", GOOGLE_AI_SOURCE_TYPE);
    if (error)
      return failure(
        "SOURCE_DELETE_FAILED",
        "Could not disconnect Google AI. Please try again."
      );
    // Removes this workspace's stored key; never revokes the customer's Google key.
    return NextResponse.json({ success: true }, { headers });
  } catch {
    return failure(
      "SOURCE_DELETE_FAILED",
      "Could not disconnect Google AI. Please try again."
    );
  }
}
