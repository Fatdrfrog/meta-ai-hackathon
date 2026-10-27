import {
  asNullableWhatsAppRecord,
  type WhatsAppJsonRecord,
} from "@icecore/shared/lib/whatsapp/value-utils";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

import { WHATSAPP_IN_APP_SIGNUP_POLICY_TOS_URL } from "./docs";

type WhatsAppInAppSignupPolicy = Record<string, unknown> & {
  tos: typeof WHATSAPP_IN_APP_SIGNUP_POLICY_TOS_URL;
};

type WhatsAppInAppSignupValidationIssue = {
  field: string;
  code: string;
  message: string;
};

function buildWhatsAppInAppSignupPolicy(
  policy?: unknown
): WhatsAppInAppSignupPolicy {
  return {
    ...(asNullableWhatsAppRecord(policy) || {}),
    tos: WHATSAPP_IN_APP_SIGNUP_POLICY_TOS_URL,
  };
}

export function normalizeWhatsAppInAppSignupPayload<
  TPayload extends WhatsAppJsonRecord,
>(
  payload: TPayload
): Omit<TPayload, "policy"> & { policy: WhatsAppInAppSignupPolicy } {
  return {
    ...payload,
    policy: buildWhatsAppInAppSignupPolicy(payload.policy),
  } as Omit<TPayload, "policy"> & { policy: WhatsAppInAppSignupPolicy };
}

function normalizeWhatsAppSignupPhoneNumber(value: unknown): string {
  return readTrimmedString(value).replace(/\D/g, "");
}

export function buildWhatsAppInAppSignupDeepLink(params: {
  businessPhoneNumber: string;
  signupId: string;
}): string {
  const phone = normalizeWhatsAppSignupPhoneNumber(params.businessPhoneNumber);
  const signupId = readTrimmedString(params.signupId);
  if (!phone) throw new Error("businessPhoneNumber is required");
  if (!signupId) throw new Error("signupId is required");
  return `https://wa.me/${phone}/signup/${encodeURIComponent(signupId)}`;
}

export function validateWhatsAppInAppSignupPayload(payload: {
  signup_message?: unknown;
  confirmation_message?: unknown;
  privacy_policy_url?: unknown;
  website_url?: unknown;
  promo_code?: unknown;
}): WhatsAppInAppSignupValidationIssue[] {
  const issues: WhatsAppInAppSignupValidationIssue[] = [];
  const signupMessage = readTrimmedString(payload.signup_message);
  const confirmationMessage = readTrimmedString(payload.confirmation_message);
  const privacyPolicyUrl = readTrimmedString(payload.privacy_policy_url);
  const websiteUrl = readTrimmedString(payload.website_url);
  const promoCode = readTrimmedString(payload.promo_code);

  if (!signupMessage) {
    issues.push({
      field: "signup_message",
      code: "signup_message_required",
      message: "Signup message is required.",
    });
  }

  if (!confirmationMessage) {
    issues.push({
      field: "confirmation_message",
      code: "confirmation_message_required",
      message: "Confirmation message is required.",
    });
  }

  if (!/^https?:\/\/.+/i.test(privacyPolicyUrl)) {
    issues.push({
      field: "privacy_policy_url",
      code: "privacy_policy_url_required",
      message: "Privacy policy URL must start with http:// or https://.",
    });
  }

  if (websiteUrl && !/^https:\/\//i.test(websiteUrl)) {
    issues.push({
      field: "website_url",
      code: "website_url_https",
      message: "Website URL must start with https://.",
    });
  }

  const placeholders = Array.from(
    confirmationMessage.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)
  ).map(match => match[1]);
  const hasUnknownPlaceholder = placeholders.some(
    placeholder => placeholder !== "promo_code"
  );
  const usesPromoCode = placeholders.includes("promo_code");

  if (hasUnknownPlaceholder) {
    issues.push({
      field: "confirmation_message",
      code: "unknown_placeholder",
      message:
        "Only {{promo_code}} is supported in WhatsApp In-App Signup confirmation messages.",
    });
  }

  if (usesPromoCode && !promoCode) {
    issues.push({
      field: "promo_code",
      code: "promo_code_required",
      message:
        "Promo code is required when confirmation message uses {{promo_code}}.",
    });
  }

  if (promoCode && !/^[a-zA-Z0-9]+$/.test(promoCode)) {
    issues.push({
      field: "promo_code",
      code: "promo_code_alphanumeric",
      message: "Promo code must contain only letters and numbers.",
    });
  }

  return issues;
}
