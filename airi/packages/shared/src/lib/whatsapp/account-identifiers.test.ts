import assert from "node:assert/strict";
import test from "node:test";
import { buildWhatsAppAccountRowsForSource } from "./account-identifiers.js";

function rowStatus(credentials: Record<string, unknown>) {
  const [row] = buildWhatsAppAccountRowsForSource({
    sourceId: "source-1",
    workspaceId: "workspace-1",
    companyId: "company-1",
    credentials: {
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      ...credentials,
    },
  });
  return row?.connection_status;
}

test("stores the source's current connection status on its account row", () => {
  assert.equal(rowStatus({}), "active");
  assert.equal(
    rowStatus({
      coexistence_reonboarding_status: "offboarded",
      cloud_api_messaging_suspended: true,
    }),
    "offboarded",
  );
  assert.equal(
    rowStatus({
      coexistence_reonboarding_status: "removed",
      cloud_api_messaging_suspended: true,
    }),
    "removed",
  );
  assert.equal(
    rowStatus({
      coexistence_reonboarding_status: "reconnected",
      cloud_api_messaging_suspended: false,
      coexistence_mode: true,
      partner_app_installed: true,
    }),
    "active",
  );
});

test("keeps the company on source-bound account rows", () => {
  const [row] = buildWhatsAppAccountRowsForSource({
    sourceId: "source-1",
    workspaceId: "workspace-1",
    companyId: "company-1",
    credentials: { waba_id: "waba-1", phone_number_id: "phone-1" },
  });
  assert.equal(row?.company_id, "company-1");
  assert.equal(row?.account_key, "phone:phone-1");
});
