import { z } from "zod";

const optionalTrimmedString = (max = 240) =>
  z.preprocess(value => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed || undefined;
  }, z.string().max(max).optional());

const clearableTrimmedString = (max = 240) =>
  z.preprocess(value => {
    if (value === undefined) return undefined;
    if (value === null) return "";
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed || undefined;
  }, z.string().max(max).optional());

const requiredTrimmedString = (field: string, max = 2000) =>
  z
    .string({
      required_error: `${field} is required`,
      invalid_type_error: `${field} must be a string`,
    })
    .trim()
    .min(1, `${field} is required`)
    .max(max, `${field} is too long`);

const optionalRequiredTrimmedString = (field: string, max = 2000) =>
  z.preprocess(
    value => {
      if (value === undefined) return undefined;
      if (typeof value !== "string") return value;
      return value.trim();
    },
    z
      .string({ invalid_type_error: `${field} must be a string` })
      .min(1, `${field} is required`)
      .max(max, `${field} is too long`)
      .optional()
  );

const requiredUrlString = (field: string) =>
  requiredTrimmedString(field, 2048).url(`${field} must be a valid URL`);

const optionalUrlString = (field: string) =>
  z.preprocess(
    value => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed || undefined;
    },
    z
      .string({ invalid_type_error: `${field} must be a string` })
      .url(`${field} must be a valid URL`)
      .max(2048, `${field} is too long`)
      .optional()
  );

const clearableUrlString = (field: string) =>
  z.preprocess(
    value => {
      if (value === undefined) return undefined;
      if (value === null) return "";
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed || undefined;
    },
    z
      .union([
        z.literal(""),
        z
          .string({ invalid_type_error: `${field} must be a string` })
          .url(`${field} must be a valid URL`)
          .max(2048, `${field} is too long`),
      ])
      .optional()
  );

export const createWhatsAppSignupBodySchema = z.object({
  workspaceId: requiredTrimmedString("workspaceId", 160),
  businessPhoneNumber: optionalTrimmedString(80),
  displayName: optionalTrimmedString(160),
  signupMessage: requiredTrimmedString("signupMessage"),
  confirmationMessage: requiredTrimmedString("confirmationMessage"),
  privacyPolicyUrl: requiredUrlString("privacyPolicyUrl"),
  websiteUrl: optionalUrlString("websiteUrl"),
  promoCode: optionalTrimmedString(160),
  productLine: optionalTrimmedString(160),
  shop: optionalTrimmedString(160),
  campaign: optionalTrimmedString(160),
  landingPage: optionalTrimmedString(240),
  ad: optionalTrimmedString(240),
  checkoutFlow: optionalTrimmedString(160),
  messagingCustomerBaseId: optionalTrimmedString(160),
});

export const updateWhatsAppSignupBodySchema = z.object({
  workspaceId: requiredTrimmedString("workspaceId", 160),
  displayName: clearableTrimmedString(160),
  signupMessage: optionalRequiredTrimmedString("signupMessage"),
  confirmationMessage: optionalRequiredTrimmedString("confirmationMessage"),
  websiteUrl: clearableUrlString("websiteUrl"),
  promoCode: clearableTrimmedString(160),
  productLine: clearableTrimmedString(160),
  shop: clearableTrimmedString(160),
  campaign: clearableTrimmedString(160),
  landingPage: clearableTrimmedString(240),
  ad: clearableTrimmedString(240),
  checkoutFlow: clearableTrimmedString(160),
  messagingCustomerBaseId: clearableTrimmedString(160),
  status: z.preprocess(
    value => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(["ACTIVE", "DISABLED"]).optional()
  ),
});

export const createMessagingCustomerBaseBodySchema = z.object({
  workspaceId: requiredTrimmedString("workspaceId", 160),
  name: requiredTrimmedString("name", 160),
});

export const setDefaultMessagingCustomerBaseBodySchema = z.object({
  workspaceId: requiredTrimmedString("workspaceId", 160),
  customerBaseId: requiredTrimmedString("customerBaseId", 160),
});

export { errorMessageResponse, zodErrorResponse } from "@/lib/api/json-body";
