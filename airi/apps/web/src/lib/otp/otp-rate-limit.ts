export {
  assertWhatsAppOtpRequestAllowed,
  getOtpRateLimitBackend,
  installOtpRateLimitValkeyForTests,
  OTP_RATE_LIMIT_UNAVAILABLE_ERROR,
  resetOtpRateLimitForTests,
  shouldSkipUpstashOtpRateLimitFallback,
} from "@icecore/otp-runtime";
