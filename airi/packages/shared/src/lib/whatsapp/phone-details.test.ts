import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWhatsAppPhoneDetailsCredentialPatch,
  getWhatsAppPhoneNumberReadiness,
  isWhatsAppPhoneNumberRegistered,
  type WhatsAppPhoneNumberDetails,
} from "./phone-details";

const details: WhatsAppPhoneNumberDetails = {
  id: "phone-1",
  verified_name: "Airi",
  display_phone_number: "+15551234567",
  quality_rating: "GREEN",
  whatsapp_business_manager_messaging_limit: "TIER_2K",
  code_verification_status: "VERIFIED",
  status: "CONNECTED",
  platform_type: "CLOUD_API",
  is_on_biz_app: false,
  is_pin_enabled: true,
  throughput: { level: "STANDARD" },
  name_status: "APPROVED",
};

test("maps Meta phone details into canonical WhatsApp credential fields", () => {
  assert.deepEqual(buildWhatsAppPhoneDetailsCredentialPatch(details), {
    phone_registration_status: "CONNECTED",
    platform_type: "CLOUD_API",
    display_phone_number: "+15551234567",
    verified_name: "Airi",
    name_status: "APPROVED",
    quality_rating: "GREEN",
    is_on_biz_app: false,
    whatsapp_business_manager_messaging_limit: "TIER_2K",
    phone_messaging_limit: "TIER_2K",
  });
});

test("uses connection status rather than OTP verification or platform as registration evidence", () => {
  assert.equal(isWhatsAppPhoneNumberRegistered(details), true);
  assert.equal(
    isWhatsAppPhoneNumberRegistered({ ...details, status: undefined }),
    false,
  );
  assert.equal(
    isWhatsAppPhoneNumberRegistered({ ...details, status: "PENDING" }),
    false,
  );
  assert.equal(
    isWhatsAppPhoneNumberRegistered({ status: " connected " }),
    true,
  );
});

test("preserves confirmed registration only when Meta omits connection status", () => {
  for (const phone_registration_status of ["REGISTERED", "CONNECTED"]) {
    const credentials = { phone_registered: true, phone_registration_status };
    assert.equal(isWhatsAppPhoneNumberRegistered({}, credentials), true);
    assert.equal(
      isWhatsAppPhoneNumberRegistered({ status: "PENDING" }, credentials),
      false,
    );
  }
  assert.equal(
    isWhatsAppPhoneNumberRegistered(
      {},
      {
        phone_registered: true,
        phone_registration_status: "VERIFIED",
      },
    ),
    false,
  );
  assert.equal(
    isWhatsAppPhoneNumberRegistered(
      {},
      {
        phone_registered: false,
        phone_registration_status: "REGISTERED",
      },
    ),
    false,
  );
});

test("OTP verification does not overwrite a recorded registration outcome", () => {
  const patch = buildWhatsAppPhoneDetailsCredentialPatch({
    id: "phone-1",
    code_verification_status: "VERIFIED",
  });
  assert.equal("phone_registration_status" in patch, false);
});

test("accepts Meta's documented Business App and Cloud API coexistence proof", () => {
  const coexistenceDetails = {
    ...details,
    status: undefined,
    is_on_biz_app: true,
  };
  assert.equal(isWhatsAppPhoneNumberRegistered(coexistenceDetails), true);
  assert.equal(
    buildWhatsAppPhoneDetailsCredentialPatch(coexistenceDetails)
      .phone_registration_status,
    "REGISTERED",
  );
  assert.equal(
    isWhatsAppPhoneNumberRegistered({
      ...coexistenceDetails,
      platform_type: "SMB",
    }),
    false,
  );
  assert.equal(
    isWhatsAppPhoneNumberRegistered({
      ...coexistenceDetails,
      status: "PENDING",
    }),
    false,
  );
});

test("QR registration readiness requires a connection as well as verified ownership", () => {
  for (const status of [undefined, "PENDING"]) {
    const readiness = getWhatsAppPhoneNumberReadiness({ ...details, status });
    assert.equal(readiness.ready, false);
    assert.ok(readiness.issues?.some((issue) => issue.includes("Cloud API")));
  }
});

test("derives readiness without another provider read", () => {
  assert.deepEqual(getWhatsAppPhoneNumberReadiness(details), {
    ready: true,
    status: "VERIFIED",
  });

  assert.deepEqual(
    getWhatsAppPhoneNumberReadiness({
      ...details,
      code_verification_status: "NOT_VERIFIED",
      name_status: "PENDING",
      quality_rating: "RED",
    }),
    {
      ready: false,
      status: "NOT_VERIFIED",
      issues: [
        "Phone number not verified (status: NOT_VERIFIED)",
        "Display name not approved (status: PENDING)",
        "Phone number has RED quality rating - messaging may be limited",
      ],
    },
  );
});

test("omits unavailable provider fields so credential merges preserve stored values", () => {
  const sparseDetails: WhatsAppPhoneNumberDetails = {
    id: "phone-1",
  };
  const storedCredentials = {
    phone_registration_status: "VERIFIED",
    platform_type: "CLOUD_API",
    display_phone_number: "+15551234567",
    verified_name: "Airi",
    name_status: "APPROVED",
    quality_rating: "GREEN",
  };

  assert.deepEqual(
    {
      ...storedCredentials,
      ...buildWhatsAppPhoneDetailsCredentialPatch(sparseDetails),
    },
    storedCredentials,
  );
});

test("reports readiness as unavailable when Meta omits readiness fields", () => {
  const sparseDetails: WhatsAppPhoneNumberDetails = {
    id: "phone-1",
  };

  assert.deepEqual(getWhatsAppPhoneNumberReadiness(sparseDetails), {
    ready: false,
    status: "UNAVAILABLE",
    issues: [
      "Phone number is not connected to Cloud API (status: UNAVAILABLE)",
      "Phone number verification status is unavailable",
      "Display name status is unavailable",
    ],
  });
});
