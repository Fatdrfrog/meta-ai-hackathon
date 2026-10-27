"use server";

import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";
import { z } from "zod";
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";

const authLimiter = createRateLimiter(rateLimitPresets.auth);
const emailSchema = z.string().email("Invalid email address");

async function getAuthRedirectBaseUrl(): Promise<string> {
  const headerStore = await headers();
  const forwardedHost = headerStore.get("x-forwarded-host");
  const host = forwardedHost || headerStore.get("host");
  if (host) {
    const forwardedProto = headerStore.get("x-forwarded-proto");
    const protocol =
      forwardedProto ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https");
    return `${protocol}://${host}`.replace(/\/$/, "");
  }

  const originHeader = headerStore.get("origin");
  if (originHeader) {
    return originHeader.replace(/\/$/, "");
  }

  return (process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat").replace(
    /\/$/,
    ""
  );
}

// Public password-reset action is email-validated, rate-limited, and only sends Supabase reset mail.
// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function resetPassword(email: string): Promise<{
  success: boolean;
  error?: string;
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
    `reset-pwd:${ip}`,
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

  const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
    redirectTo: `${siteUrl}/auth/reset-password`,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}
