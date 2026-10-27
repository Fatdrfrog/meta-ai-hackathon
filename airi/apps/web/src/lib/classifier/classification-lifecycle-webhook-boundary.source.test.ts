import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const PRODUCTION_OWNERS = [
  "apps/web/src/app/api/conversations/[id]/reopen/route.ts",
  "apps/web/src/app/api/telegram/handleCallbackQuery.ts",
  "apps/web/src/app/api/telegram/helpers.ts",
  "apps/web/src/app/api/widget/conversations/[id]/csat/route.ts",
  "apps/web/src/app/api/widget/conversations/route.ts",
  "apps/web/src/lib/widget-csat.ts",
  "apps/web/src/lib/instagram/webhook-handlers.ts",
  "packages/airi-runtime/src/whatsapp-webhook-runtime.ts",
] as const;
const PAYLOAD_BUILDER =
  "packages/shared/src/lib/conversation-lifecycle-webhook.ts";
const PAYLOAD_BUILDER_SUBPATH =
  "@icecore/shared/lib/conversation-lifecycle-webhook";
const FORBIDDEN_RAW_PAYLOADS = [
  "classification: conversation.classification",
  "classification: convo.classification",
  "classification: conversationDoc.classification",
] as const;

function readSource(path: string) {
  return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

describe("classification lifecycle webhook source boundary", () => {
  it("guards exactly the eight external resolved/reopened production owners", () => {
    expect(PRODUCTION_OWNERS).toHaveLength(8);
    expect(new Set(PRODUCTION_OWNERS).size).toBe(8);
  });

  it("builds the payload classification only through the shared freshness getter", () => {
    const source = readSource(PAYLOAD_BUILDER);

    expect(source).toContain('from "./conversation-classification-freshness"');
    expect(source).toMatch(
      /const\s+classification\s*=\s*getCurrentConversationClassification/
    );
    for (const forbiddenPayload of FORBIDDEN_RAW_PAYLOADS) {
      expect(source).not.toContain(forbiddenPayload);
    }
  });

  it.each(PRODUCTION_OWNERS)(
    "%s builds its payload with the shared builder and no raw classification",
    owner => {
      const source = readSource(owner);

      expect(source).toContain(`from "${PAYLOAD_BUILDER_SUBPATH}"`);
      expect(source).toMatch(/\bbuildConversationEventData\(/);
      expect(source).not.toMatch(/\bgetCurrentConversationClassification\b/);
      for (const forbiddenPayload of FORBIDDEN_RAW_PAYLOADS) {
        expect(source).not.toContain(forbiddenPayload);
      }
    }
  );
});
