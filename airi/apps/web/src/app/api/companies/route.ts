import { ensureNewWorkspaceAiriDefaults } from "@/lib/airi/workspace-bot-default";
import {
  setCompanyProperties,
  trackUserRegistration,
  trackWorkspaceCreated,
} from "@/lib/analytics";
import {
  normalizeRegistrationPhone,
  upsertRegisteredBusinessPhoneContact,
} from "@/lib/customers/registration-contact";
import { getAiriRegistrationFollowUpWorkspaceId } from "@/lib/email/airi-workspace";
import { getWorkspaceEmailAutomationSettings } from "@/lib/email/email-automation-settings";
import { sendRegistrationFollowUpEmail } from "@/lib/email/registration-follow-up";
import {
  buildWorkspaceOnboardingState,
  buildWorkspaceOnboardingUpsert,
} from "@/lib/onboarding/workspace-onboarding";
import { flushServerPostHog } from "@/lib/posthog/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { readServerTrackingConsent } from "@/lib/tracking-consent-server";
import { createClient } from "@/lib/supabase/server";
import { WHATSAPP_TEST_PHONE_METADATA_KEY } from "@/lib/whatsapp/test-send";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import type { User } from "@supabase/supabase-js";
import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import {
  readStringOrEmpty,
  readStringArray,
} from "@icecore/shared/lib/value-utils";

type CreateSignupWorkspaceRpcRow = {
  company_id?: unknown;
  workspace_id?: unknown;
  source_id?: unknown;
  workspace_name?: unknown;
  created?: unknown;
};

const CreateCompanyBodySchema = z
  .object({
    name: z.string(),
    phone: z.string().optional(),
    signup_referral_source: z.string().max(300).optional(),
    business_context: z.string().optional(),
    dynamic_context_tags: z.array(z.string()).optional(),
    accepted_privacy: z.literal(true),
  })
  .strict();

const COMPANY_CREATION_FAILED_RESPONSE = {
  error: "Unable to create company. Please try again.",
  code: "company_creation_failed",
} as const;

function getCreateCompanyValidationError(error: z.ZodError): string {
  if (error.issues.some(issue => issue.path[0] === "name")) {
    return "Company name is required";
  }
  if (error.issues.some(issue => issue.path[0] === "accepted_privacy")) {
    return "Privacy Policy must be accepted to proceed";
  }
  if (error.issues.some(issue => issue.path[0] === "signup_referral_source")) {
    return "Referral source is invalid";
  }
  return "Invalid company data";
}

function normalizeWorkspaceName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeSignupReferralSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeDynamicContextTags(value: unknown): string[] | null {
  const tags = readStringArray(value);
  return tags.length > 0 ? tags : null;
}

function coerceCreateSignupWorkspaceResult(raw: unknown): {
  companyId: string;
  workspaceId: string;
  sourceId: string | null;
  workspaceName: string;
  created: boolean;
} | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return null;

  const candidate = row as CreateSignupWorkspaceRpcRow;
  const companyId =
    typeof candidate.company_id === "string" ? candidate.company_id.trim() : "";
  const workspaceId =
    typeof candidate.workspace_id === "string"
      ? candidate.workspace_id.trim()
      : "";
  const sourceId =
    typeof candidate.source_id === "string" ? candidate.source_id.trim() : "";
  const workspaceName =
    typeof candidate.workspace_name === "string"
      ? candidate.workspace_name.trim()
      : "";

  if (!companyId || !workspaceId || !workspaceName) {
    return null;
  }

  return {
    companyId,
    workspaceId,
    sourceId: sourceId || null,
    workspaceName,
    created: candidate.created === true,
  };
}

async function syncUserProfile(user: User): Promise<void> {
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const fullName = (metadata?.full_name || metadata?.name) as
    | string
    | undefined;
  const avatarUrl = metadata?.avatar_url as string | undefined;

  await supabaseAdmin.from("users").upsert(
    {
      id: user.id,
      full_name: fullName ?? user.email?.split("@")[0] ?? null,
      avatar_url: avatarUrl ?? null,
    },
    { onConflict: "id" }
  );
}

async function initializeWorkspaceOnboardingProgress(
  workspaceId: string
): Promise<void> {
  const onboarding = buildWorkspaceOnboardingState({
    workspaceId,
    metrics: {
      successfulTestAnswersCount: 0,
      activeScenariosCount: 0,
      publishedKbArticlesCount: 0,
      verifiedSnippetsCount: 0,
      connectedSourcesCount: 0,
    },
    connectedSourceTypes: [],
  });

  const { error } = await supabaseAdmin
    .from("workspace_onboarding_progress")
    .upsert(buildWorkspaceOnboardingUpsert(onboarding), {
      onConflict: "workspace_id",
    });

  if (error) {
    console.warn("Workspace onboarding progress initialization skipped", {
      workspaceId,
      error,
    });
  }
}

async function storeSignupReferralSource(
  companyId: string,
  signupReferralSource: string
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("companies")
    .update({ signup_referral_source: signupReferralSource })
    .eq("id", companyId);

  if (error) {
    console.warn("Signup referral source persistence skipped", {
      companyId,
      error,
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const parsedBody = CreateCompanyBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: getCreateCompanyValidationError(parsedBody.error) },
        { status: 400 }
      );
    }

    const {
      name,
      phone,
      signup_referral_source,
      business_context,
      dynamic_context_tags,
    } = parsedBody.data;
    const normalizedName = normalizeWorkspaceName(name);
    const trimmedPhone = typeof phone === "string" ? phone.trim() : "";
    const normalizedPhone = trimmedPhone
      ? normalizeRegistrationPhone(trimmedPhone)
      : null;
    const normalizedBusinessContext = readStringOrEmpty(business_context, {
      trim: true,
    });
    const normalizedSignupReferralSource = normalizeSignupReferralSource(
      signup_referral_source
    );
    const normalizedDynamicContextTags =
      normalizeDynamicContextTags(dynamic_context_tags);

    if (!normalizedName) {
      return NextResponse.json(
        { error: "Company name is required" },
        { status: 400 }
      );
    }

    if (trimmedPhone && !normalizedPhone) {
      return NextResponse.json(
        { error: "Phone number is invalid" },
        { status: 400 }
      );
    }

    // Business context is optional at signup; fall back to the company name so
    // downstream workspace/RAG flows still have a minimal company profile.
    const effectiveBusinessContext =
      normalizedBusinessContext || normalizedName;

    await syncUserProfile(user);

    if (!user.email) {
      return NextResponse.json(
        { error: "User email is required to create a company" },
        { status: 400 }
      );
    }

    const { data: createData, error: createError } = await supabaseAdmin.rpc(
      "create_signup_workspace",
      {
        input_user_id: user.id,
        input_user_email: user.email,
        input_workspace_name: normalizedName,
        input_business_context: effectiveBusinessContext,
        input_dynamic_context_tags: normalizedDynamicContextTags,
        input_source_type: "telegram",
      }
    );

    if (createError) throw createError;

    const creationResult = coerceCreateSignupWorkspaceResult(createData);
    if (!creationResult) {
      throw new Error("Failed to create workspace.");
    }

    // The database RPC still returns its historical placeholder source. The
    // visible Telegram integration should only exist after a real bot token is saved.
    if (creationResult.created && creationResult.sourceId) {
      const { error: deletePlaceholderSourceError } = await supabaseAdmin
        .from("sources")
        .delete()
        .eq("id", creationResult.sourceId)
        .eq("workspace_id", creationResult.workspaceId)
        .eq("type", "telegram");

      if (deletePlaceholderSourceError) {
        throw deletePlaceholderSourceError;
      }
    }

    if (creationResult.created && normalizedSignupReferralSource) {
      await storeSignupReferralSource(
        creationResult.companyId,
        normalizedSignupReferralSource
      );
    }

    const metadata = user.user_metadata as Record<string, unknown> | undefined;
    const fullName = (metadata?.full_name || metadata?.name) as
      | string
      | undefined;

    if (creationResult.created) {
      await initializeWorkspaceOnboardingProgress(creationResult.workspaceId);
      try {
        await ensureNewWorkspaceAiriDefaults({
          workspaceId: creationResult.workspaceId,
          updatedBy: user.id,
        });
      } catch (error) {
        console.warn("Workspace Airi defaults seed skipped", {
          workspaceId: creationResult.workspaceId,
          error,
        });
      }

      // Read while the request is in scope; the tasks below may run after it.
      const analyticsConsent = await readServerTrackingConsent();
      const postCreationTasks = async () => {
        // Track analytics (wrap in try-catch to prevent analytics errors from breaking the flow)
        try {
          trackUserRegistration(
            user.id,
            creationResult.companyId,
            creationResult.workspaceId,
            "admin",
            "self_signup",
            user.email!,
            fullName,
            { consent: analyticsConsent }
          );

          trackWorkspaceCreated(
            creationResult.companyId,
            creationResult.workspaceId,
            creationResult.workspaceName,
            user.id,
            { consent: analyticsConsent }
          );

          setCompanyProperties(creationResult.companyId, {
            company_name: normalizedName,
            business_context: effectiveBusinessContext,
            dynamic_context_tags: normalizedDynamicContextTags ?? undefined,
            ...(normalizedSignupReferralSource
              ? { signup_referral_source: normalizedSignupReferralSource }
              : {}),
          });
        } catch (analyticsError) {
          console.error(
            "Analytics tracking error (non-fatal):",
            analyticsError
          );
        }

        // Prefills "Send a test to my WhatsApp"; a failed write only loses
        // the prefill.
        const testPhone = normalizedPhone
          ? normalizeWhatsAppPhone(normalizedPhone)
          : null;
        if (testPhone) {
          try {
            await supabase.auth.updateUser({
              data: { [WHATSAPP_TEST_PHONE_METADATA_KEY]: testPhone },
            });
          } catch {
            // The workspace exists; the prefill is optional.
          }
        }

        try {
          const senderWorkspaceId = getAiriRegistrationFollowUpWorkspaceId();
          if (normalizedPhone) {
            try {
              await upsertRegisteredBusinessPhoneContact({
                senderWorkspaceId,
                registeredCompanyId: creationResult.companyId,
                registeredWorkspaceId: creationResult.workspaceId,
                registeredWorkspaceName: creationResult.workspaceName,
                userId: user.id,
                userEmail: user.email!,
                userName: fullName ?? null,
                phone: normalizedPhone,
              });
            } catch (contactError) {
              console.warn("Registration phone contact sync failed", {
                userId: user.id,
                workspaceId: creationResult.workspaceId,
                senderWorkspaceId,
                error:
                  contactError instanceof Error
                    ? contactError.message
                    : String(contactError),
              });
            }
          }

          const emailAutomationSettings =
            await getWorkspaceEmailAutomationSettings(senderWorkspaceId);

          if (emailAutomationSettings.registrationFollowUpEnabled) {
            const followUpResult = await sendRegistrationFollowUpEmail({
              userId: user.id,
              userEmail: user.email!,
              userName: fullName ?? null,
              companyId: creationResult.companyId,
              workspaceId: creationResult.workspaceId,
              senderWorkspaceId,
              workspaceName: creationResult.workspaceName,
              template: emailAutomationSettings.registrationFollowUpTemplate,
            });

            if (
              !followUpResult.ok &&
              followUpResult.reason !== "not_configured"
            ) {
              console.warn("Registration follow-up email skipped or failed", {
                userId: user.id,
                workspaceId: creationResult.workspaceId,
                senderWorkspaceId,
                reason: followUpResult.reason,
                error: followUpResult.error,
              });
            }
          }
        } catch (followUpError) {
          console.warn("Registration follow-up email skipped or failed", {
            userId: user.id,
            workspaceId: creationResult.workspaceId,
            error:
              followUpError instanceof Error
                ? followUpError.message
                : String(followUpError),
          });
        }

        await flushServerPostHog();
      };

      if (process.env.NODE_ENV === "test") {
        await postCreationTasks();
      } else {
        try {
          after(postCreationTasks);
        } catch (afterError) {
          console.warn(
            "after() not available in this context, falling back to background promise",
            afterError
          );
          postCreationTasks().catch(err => {
            console.error("Error in background post-creation tasks:", err);
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: creationResult.created
        ? "Company and workspace created successfully!"
        : "Existing workspace returned successfully.",
      workspaceId: creationResult.workspaceId,
      companyId: creationResult.companyId,
      deduplicated: !creationResult.created,
    });
  } catch (error) {
    console.error("Error creating company:", error);

    // Log more details for debugging
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }

    // Check for specific Supabase errors
    if (error && typeof error === "object" && "code" in error) {
      const supabaseError = error as {
        code?: string;
        message?: string;
        details?: string;
      };
      console.error("Supabase error code:", supabaseError.code);
      console.error("Supabase error details:", supabaseError.details);

      // Return more specific error messages for common issues
      if (supabaseError.code === "23505") {
        return NextResponse.json(
          { error: "A company with this name or slug already exists" },
          { status: 409 }
        );
      }
      if (supabaseError.code === "P0001") {
        return NextResponse.json(
          { error: "Invalid company data" },
          { status: 400 }
        );
      }
      if (supabaseError.code === "23503") {
        return NextResponse.json(
          {
            error:
              "Invalid reference: One of the related records does not exist",
          },
          { status: 400 }
        );
      }
    }

    return NextResponse.json(COMPANY_CREATION_FAILED_RESPONSE, {
      status: 500,
    });
  }
}
