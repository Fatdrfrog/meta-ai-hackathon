"use server";

import { getAuthEmailCooldownSeconds } from "@/lib/auth/auth-email-cooldown";
import { getAuthRedirectBaseUrl } from "@/lib/auth/redirect-base-url";
import { getSafeAuthReturnPath } from "@/lib/auth/safe-return-path";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";
import { headers } from "next/headers";
import { z } from "zod";

const authLimiter = createRateLimiter(rateLimitPresets.auth);
const emailSchema = z.string().email("Invalid email address");

function getMagicLinkCallbackUrl(siteUrl: string, nextPath?: string) {
  const callbackUrl = new URL("/auth/callback", siteUrl);
  const safeNextPath = getSafeAuthReturnPath(nextPath);
  if (safeNextPath) {
    callbackUrl.searchParams.set("next", safeNextPath);
  }

  return callbackUrl.toString();
}

// Public sign-in action is email-validated, rate-limited, and creates no session-owned data.
// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function sendMagicLink(
  email: string,
  nextPath?: string
): Promise<{
  success: boolean;
  error?: string;
  retryAfterSeconds?: number;
}> {
  const normalizedEmail = (email || "").trim();

  if (!normalizedEmail) {
    return { success: false, error: "Email is required." };
  }

  // 1. Zod Email Validation
  const emailResult = emailSchema.safeParse(normalizedEmail);
  if (!emailResult.success) {
    return { success: false, error: "Invalid email address." };
  }

  // 2. Upstash Rate Limiting
  const headerStore = await headers();
  const ip = headerStore.get("x-forwarded-for") || "127.0.0.1";
  const rateLimitResult = await checkRateLimit(
    authLimiter,
    `magic-link:${ip}`,
    5
  );
  if (!rateLimitResult.success) {
    return {
      success: false,
      error: "Too many attempts. Please try again in 5 minutes.",
    };
  }

  const supabase = await createClient();
  const siteUrl = await getAuthRedirectBaseUrl();

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: getMagicLinkCallbackUrl(siteUrl, nextPath),
      shouldCreateUser: false,
    },
  });

  if (error) {
    if (error.message.includes("signups are disabled")) {
      return {
        success: false,
        error: "Account not found. Please sign up first.",
      };
    }
    const retryAfterSeconds = getAuthEmailCooldownSeconds(error);
    if (retryAfterSeconds !== null) {
      return { success: false, error: error.message, retryAfterSeconds };
    }
    return { success: false, error: error.message };
  }

  return { success: true };
}
