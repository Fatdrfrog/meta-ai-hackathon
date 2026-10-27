import "./install-web-otp-runtime";

export {
  assertSupportedOtpTemplate,
  deleteOtpTemplateBinding,
  getActiveOtpTemplateBinding,
  listOtpTemplateBindings,
  normalizeOtpMaxAttempts,
  normalizeOtpPurpose,
  normalizeOtpTtlSeconds,
  upsertOtpTemplateBinding,
} from "@icecore/otp-runtime";
