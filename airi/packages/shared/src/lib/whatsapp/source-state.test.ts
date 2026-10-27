import assert from "node:assert/strict";
import test from "node:test";
import type { Source } from "../../types/sources";
import {
  deriveWhatsAppSourceConnectionStatus,
  getWhatsAppWebhookSourceSkip,
  isDisconnectedWhatsAppSource,
  isRemovedWhatsAppSource,
  isWhatsAppCloudApiMessagingSuspended,
} from "./source-state.js";

type SourceOverrides = Omit<Partial<Source>, "credentials"> & {
  credentials?: Record<string, unknown>;
};

function source(overrides: SourceOverrides): Source {
  return {
    id: "source-1",
    created_at: "2026-01-01T00:00:00.000Z",
    company_id: "company-1",
    workspace_id: "workspace-1",
    name: "WhatsApp",
    type: "whatsapp",
    credentials: {},
    ...overrides,
  } as Source;
}

test("treats offboarded Cloud API messaging as suspended", () => {
  assert.equal(
    isWhatsAppCloudApiMessagingSuspended({
      coexistence_reonboarding_status: "offboarded",
    }),
    true,
  );
});

test("treats removed partner access as disconnected and removed", () => {
  const removedSource = source({
    credentials: {
      coexistence_reonboarding_status: "removed",
    },
  });

  assert.equal(
    isWhatsAppCloudApiMessagingSuspended(removedSource.credentials),
    true,
  );
  assert.equal(isDisconnectedWhatsAppSource(removedSource), true);
  assert.equal(isRemovedWhatsAppSource(removedSource), true);
  assert.deepEqual(getWhatsAppWebhookSourceSkip(removedSource), {
    reason: "partner_removed",
    message: "WhatsApp partner app access was removed.",
  });
});

test("skips webhooks when coexistence mode lost partner app access", () => {
  assert.deepEqual(
    getWhatsAppWebhookSourceSkip(
      source({
        credentials: {
          coexistence_mode: true,
          partner_app_installed: false,
        },
      }),
    ),
    {
      reason: "cloud_api_messaging_suspended",
      message: "WhatsApp Cloud API messaging is suspended for this source.",
    },
  );
});

test("does not skip active WhatsApp sources", () => {
  const activeSource = source({
    credentials: {
      access_token: "token-1",
      phone_number_id: "phone-1",
      coexistence_mode: true,
      partner_app_installed: true,
    },
  });

  assert.equal(isDisconnectedWhatsAppSource(activeSource), false);
  assert.equal(isRemovedWhatsAppSource(activeSource), false);
  assert.equal(getWhatsAppWebhookSourceSkip(activeSource), null);
});

test("derives the account connection status from source credentials", () => {
  assert.equal(
    deriveWhatsAppSourceConnectionStatus({
      coexistence_mode: true,
      partner_app_installed: true,
    }),
    "active",
  );
  assert.equal(
    deriveWhatsAppSourceConnectionStatus({
      coexistence_reonboarding_status: "reconnected",
      cloud_api_messaging_suspended: false,
    }),
    "active",
  );
  assert.equal(
    deriveWhatsAppSourceConnectionStatus({
      coexistence_reonboarding_status: "offboarded",
    }),
    "offboarded",
  );
  assert.equal(
    deriveWhatsAppSourceConnectionStatus({
      cloud_api_messaging_suspended: true,
    }),
    "offboarded",
  );
  assert.equal(
    deriveWhatsAppSourceConnectionStatus({
      coexistence_mode: true,
      partner_app_installed: false,
    }),
    "offboarded",
  );
  assert.equal(
    deriveWhatsAppSourceConnectionStatus({
      coexistence_reonboarding_status: "removed",
      cloud_api_messaging_suspended: true,
    }),
    "removed",
  );
  assert.equal(deriveWhatsAppSourceConnectionStatus(null), "active");
});
