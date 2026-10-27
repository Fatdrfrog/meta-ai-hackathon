import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { AiriTurnExecutionStore } from "@icecore/airi-runtime";
import { cache } from "@icecore/shared/lib/cache";
import { AIRI_COMPANY_CAPACITY_DEFERRED } from "@icecore/temporal";
import { classifyTurnFailure } from "../workflows/airi-conversation-turn-recovery.js";

// Load the real worker/web composition with inert clients. No external service
// is called: capacity is denied through the existing shared cache port.
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/airi_capacity_boundary_test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "capacity-test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "capacity-test-service-role";

const require = createRequire(import.meta.url);
const commonJsCache = require("@icecore/shared/lib/cache")
  .cache as typeof cache;

for (const reason of ["limited", "unavailable"] as const) {
  test(`real preparation boundary durably defers ${reason} capacity before claiming a turn`, async (t) => {
    for (const port of new Set([cache, commonJsCache])) {
      t.mock.method(port, "get", async () => "company-1");
      t.mock.method(port, "acquireLock", async () =>
        reason === "limited" ? "contended" : "unavailable",
      );
    }
    const { prepareAiriConversationTurn } = await import(
      "./airi-auto-reply.js"
    );
    let preparationCalls = 0;
    const unexpectedPreparation = async (): Promise<never> => {
      preparationCalls++;
      throw new Error("Capacity denial must precede mutable preparation");
    };
    const executionStore: AiriTurnExecutionStore = {
      claimAiriTurnPreparation: unexpectedPreparation,
      completeAiriTurnPreparation: unexpectedPreparation,
      failAiriTurnPreparation: unexpectedPreparation,
      recordAiriConversationTurnDisposition: unexpectedPreparation,
    };

    await assert.rejects(
      prepareAiriConversationTurn(
        {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "message-1",
          turnContextId: "context-1",
        },
        executionStore,
      ),
      (error: unknown) => {
        const failure = error as { type?: string; nonRetryable?: boolean };
        assert.equal(failure.type, AIRI_COMPANY_CAPACITY_DEFERRED);
        assert.equal(failure.nonRetryable, true);
        assert.equal(
          classifyTurnFailure(
            "prepare",
            { cause: error },
            {
              retryCompanyCapacity: true,
            },
          ),
          "retryable",
        );
        return true;
      },
    );
    assert.equal(preparationCalls, 0);
  });
}
