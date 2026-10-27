import {
  SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS,
  getConnectedScenarioActionSources,
  getConnectedScenarioSourceMentions,
  getConnectedScenarioSourceOptions,
  getScenarioSourceCapabilities,
  hasConnectedScenarioSources,
  type ScenarioSourceReadinessRow,
} from "@/components/scenarios/scenario-onboarding";
import {
  SCENARIO_SOURCE_READINESS_SELECT,
  toScenarioSourceReadinessRow,
} from "./source-rows";

/** A stored row; credentials may hold any JSON, secrets included. */
type FullSourceRow = Omit<ScenarioSourceReadinessRow, "credentials"> & {
  credentials: unknown;
};

function asReadinessRows(rows: FullSourceRow[]) {
  return rows as unknown as ScenarioSourceReadinessRow[];
}

/** Representative rows of every source type, including edge shapes. */
const FULL_ROWS: FullSourceRow[] = [
  {
    id: "wa-named",
    type: "whatsapp",
    name: "Sales",
    credentials: { access_token: "secret-1", phone_number_id: "111" },
  },
  {
    id: "wa-verified",
    type: " whatsapp ",
    name: "",
    credentials: {
      access_token: "secret-2",
      verified_name: "Shop",
      display_phone_number: "+7 700",
      embedded_signup_flow: "Coexistence",
    },
  },
  {
    id: "wa-phone",
    type: "whatsapp",
    name: null,
    credentials: { display_phone_number: "+7 701", coexistence_mode: true },
  },
  {
    id: "wa-biz-app",
    type: "whatsapp",
    credentials: { phone_number_id: 222, is_on_biz_app: "true" },
  },
  {
    id: "wa-fallback",
    type: "whatsapp",
    credentials: { verified_name: null, coexistence_mode: "no" },
  },
  {
    id: "tg-ready",
    type: "telegram",
    credentials: { bot_token: " token ", bot_username: "@airi_bot" },
  },
  {
    id: "tg-placeholder",
    type: "telegram",
    name: "Placeholder",
    credentials: { bot_token: "  " },
  },
  {
    id: "email-active",
    type: "email",
    credentials: { status: "active", email_address: "a@example.com" },
  },
  {
    id: "email-paused",
    type: "email",
    credentials: { status: "paused", email_address: "b@example.com" },
  },
  {
    id: "email-no-address",
    type: "email",
    credentials: { status: "active" },
  },
  { id: "meta-ads", type: "meta_ads", credentials: { access_token: "x" } },
  { id: "calendar", type: "google_calendar", credentials: {} },
  { id: "canva", type: "canva", credentials: { refresh_token: "y" } },
  { id: "higgsfield", type: "higgsfield", credentials: null },
  { id: "instagram", type: "instagram", credentials: ["not", "a", "record"] },
  { id: "widget", type: "web_widget", credentials: "not-a-record" },
  { id: "unknown", type: "custom_crm", credentials: { status: "active" } },
  { id: "untyped", type: "", credentials: { bot_token: "t" } },
  { id: null, type: "telegram", credentials: { bot_token: "t" } },
];

/** What PostgREST returns for `alias:credentials->key` on a jsonb column. */
function projectLikePostgrest(row: FullSourceRow) {
  const credentials =
    row.credentials &&
    typeof row.credentials === "object" &&
    !Array.isArray(row.credentials)
      ? (row.credentials as Record<string, unknown>)
      : null;
  return {
    id: row.id ?? null,
    type: row.type ?? null,
    name: row.name ?? null,
    ...Object.fromEntries(
      SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS.map(key => [
        `credential_${key}`,
        credentials?.[key] ?? null,
      ])
    ),
  };
}

function deriveReadiness(rows: ScenarioSourceReadinessRow[]) {
  return {
    mentions: getConnectedScenarioSourceMentions(rows),
    options: getConnectedScenarioSourceOptions(rows),
    actionSources: getConnectedScenarioActionSources(rows),
    capabilities: getScenarioSourceCapabilities(rows),
    hasConnectedSources: hasConnectedScenarioSources(rows),
    hasGoogleCalendar: rows.some(
      row => (row.type || "").trim() === "google_calendar"
    ),
  };
}

describe("scenario source readiness projection", () => {
  it("selects each readiness key as a JSON path and never whole credentials", () => {
    const columns = SCENARIO_SOURCE_READINESS_SELECT.split(",").map(column =>
      column.trim()
    );

    expect(columns).toEqual([
      "id",
      "type",
      "name",
      ...SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS.map(
        key => `credential_${key}:credentials->${key}`
      ),
    ]);
    expect(columns).not.toContain("credentials");
  });

  it("derives the same readiness as full credentials for every source type", () => {
    const projected = FULL_ROWS.map(row =>
      toScenarioSourceReadinessRow(projectLikePostgrest(row))
    );

    expect(deriveReadiness(projected)).toEqual(
      deriveReadiness(asReadinessRows(FULL_ROWS))
    );
  });

  it.each(FULL_ROWS.map(row => [row.id ?? "no-id", row] as const))(
    "derives the same readiness for %s alone",
    (_id, row) => {
      const projected = toScenarioSourceReadinessRow(projectLikePostgrest(row));

      expect(deriveReadiness([projected])).toEqual(
        deriveReadiness(asReadinessRows([row]))
      );
    }
  );

  it("keeps secrets out of the rebuilt credentials", () => {
    const projected = FULL_ROWS.map(row =>
      toScenarioSourceReadinessRow(projectLikePostgrest(row))
    );

    expect(JSON.stringify(projected)).not.toMatch(
      /secret-|access_token|refresh_token/
    );
  });

  it("covers every credential key the readiness helpers read", () => {
    const readKeys = new Set<string>();
    const recordingRows = FULL_ROWS.map(row => ({
      ...row,
      // An empty record reaches every fallback, so every read is recorded.
      credentials: new Proxy<Record<string, unknown>>(
        {},
        {
          get(target, key) {
            if (typeof key === "string") readKeys.add(key);
            return Reflect.get(target, key);
          },
        }
      ),
    }));

    deriveReadiness(recordingRows);
    deriveReadiness(
      FULL_ROWS.map(row => ({
        ...row,
        credentials: new Proxy<Record<string, unknown>>(
          { ...(row.credentials as Record<string, unknown>) },
          {
            get(target, key) {
              if (typeof key === "string") readKeys.add(key);
              return Reflect.get(target, key);
            },
          }
        ),
      }))
    );

    expect(readKeys.size).toBeGreaterThan(0);
    expect(
      [...readKeys].filter(
        key =>
          !(
            SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS as readonly string[]
          ).includes(key)
      )
    ).toEqual([]);
  });
});
