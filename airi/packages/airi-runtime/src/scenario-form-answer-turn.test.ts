import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readScenarioFormSubmissions } from "@icecore/scenario-contracts";
import {
  readSubmittedScenarioForm,
  withSubmittedScenarioForm,
} from "./scenario-form-answer-turn";

const SUBMITTED_AT = new Date("2026-09-30T10:00:00.000Z");

const SIZE_FIELD = {
  id: "size",
  label: "Size",
  fieldType: "Dropdown",
  options: [
    { id: "0_m", title: "Medium" },
    { id: "1_l", title: "Large" },
  ],
};

function reply(values: Record<string, unknown>): string {
  return JSON.stringify({ ...values, flow_token: " flow_abc " });
}

function readParams(
  overrides: Partial<Parameters<typeof readSubmittedScenarioForm>[0]> = {},
): Parameters<typeof readSubmittedScenarioForm>[0] {
  return {
    findSubmittedScenarioForm: async () => ({
      scenarioId: "scenario-1",
      sourceActionNodeId: "order-form",
      flowId: "flow-1",
      fields: [SIZE_FIELD, { id: "address", label: "Address" }],
    }),
    workspaceId: "ws",
    conversationId: "conv-1",
    flowResponseJson: reply({ size: "1_l", address: " 5 Main St " }),
    flowName: "order_details",
    contextMessageId: " ws_wamid.form ",
    inboundMessageId: "message-1",
    submittedAt: SUBMITTED_AT,
    ...overrides,
  };
}

describe("submitted scenario forms", () => {
  it("records the answers of the form the reply cites, as it was sent", async () => {
    const lookups: unknown[] = [];
    const submitted = await readSubmittedScenarioForm(
      readParams({
        async findSubmittedScenarioForm(scope) {
          lookups.push(scope);
          return {
            scenarioId: "scenario-1",
            sourceActionNodeId: "order-form",
            flowId: "flow-1",
            fields: [SIZE_FIELD, { id: "address", label: "Address" }],
          };
        },
      }),
    );
    assert.deepEqual(lookups, [
      {
        workspaceId: "ws",
        conversationId: "conv-1",
        contextMessageId: "ws_wamid.form",
        flowToken: "flow_abc",
      },
    ]);
    assert.deepEqual(submitted, {
      scenarioId: "scenario-1",
      submission: {
        sourceActionNodeId: "order-form",
        flowId: "flow-1",
        inboundMessageId: "message-1",
        submittedAt: "2026-09-30T10:00:00.000Z",
        fields: [
          { key: "size", label: "Size", fieldType: "Dropdown", value: "Large" },
          {
            key: "address",
            label: "Address",
            fieldType: "unknown",
            value: "5 Main St",
          },
        ],
      },
    });

    const state = withSubmittedScenarioForm(
      { lockedScenarioId: "scenario-1", currentActionNodeId: "order-form" },
      submitted,
    );
    assert.equal(
      (state as { currentActionNodeId?: string }).currentActionNodeId,
      "order-form",
    );
    assert.deepEqual(
      readScenarioFormSubmissions(state, "scenario-1").map(
        (submission) => submission.sourceActionNodeId,
      ),
      ["order-form"],
    );
    assert.deepEqual(readScenarioFormSubmissions(state, "scenario-2"), []);
  });

  it("asks by the reply's flow token when the reply cites no message", async () => {
    const lookups: Array<{ contextMessageId: string | null }> = [];
    const submitted = await readSubmittedScenarioForm(
      readParams({
        contextMessageId: undefined,
        async findSubmittedScenarioForm(scope) {
          lookups.push(scope);
          return {
            scenarioId: "scenario-1",
            sourceActionNodeId: "order-form",
            flowId: null,
            fields: null,
          };
        },
      }),
    );
    assert.equal(lookups[0]?.contextMessageId, null);
    // Without the form as sent, answers keep their keys as readable labels.
    assert.deepEqual(submitted?.submission.fields, [
      { key: "size", label: "Size", fieldType: "unknown", value: "1_l" },
      {
        key: "address",
        label: "Address",
        fieldType: "unknown",
        value: "5 Main St",
      },
    ]);
  });

  it("looks nothing up for an address reply or a message without a Flow reply", async () => {
    let lookups = 0;
    const findSubmittedScenarioForm = async () => {
      lookups += 1;
      return null;
    };
    for (const overrides of [
      { flowName: "address_message" },
      { flowResponseJson: null },
      { flowResponseJson: "" },
      { flowResponseJson: "not json" },
      { flowResponseJson: "[1, 2]" },
    ]) {
      assert.equal(
        await readSubmittedScenarioForm(
          readParams({ ...overrides, findSubmittedScenarioForm }),
        ),
        null,
      );
    }
    assert.equal(lookups, 0);
    assert.equal(
      await readSubmittedScenarioForm(
        readParams({ findSubmittedScenarioForm: undefined }),
      ),
      null,
    );
  });

  it("records nothing for a form no scenario message sent", async () => {
    assert.equal(
      await readSubmittedScenarioForm(
        readParams({ findSubmittedScenarioForm: async () => null }),
      ),
      null,
    );
    const state = { lockedScenarioId: "scenario-1" };
    assert.equal(withSubmittedScenarioForm(state, null), state);
  });

  it("leaves a failed lookup to the caller, which keeps the turn going", async () => {
    await assert.rejects(
      readSubmittedScenarioForm(
        readParams({
          findSubmittedScenarioForm: async () => {
            throw new Error("storage unavailable");
          },
        }),
      ),
      /storage unavailable/,
    );
  });

  it("keeps the answers of the scenario that holds the conversation", async () => {
    const submitted = await readSubmittedScenarioForm(readParams());
    const held = withSubmittedScenarioForm(
      { lockedScenarioId: "scenario-1" },
      submitted,
    );
    // Another scenario's older form, still open, submitted while scenario-1
    // holds the conversation: scenario-1's answers stay.
    const other = await readSubmittedScenarioForm(
      readParams({
        findSubmittedScenarioForm: async () => ({
          scenarioId: "scenario-2",
          sourceActionNodeId: "contact-form",
          flowId: null,
          fields: null,
        }),
      }),
    );
    assert.equal(withSubmittedScenarioForm(held, other), held);
    assert.equal(readScenarioFormSubmissions(held, "scenario-1").length, 1);
    // Once no scenario holds it, or its own does, the form is recorded.
    for (const lockedScenarioId of [null, "", "scenario-2"]) {
      const state = withSubmittedScenarioForm(
        { ...(held as object), lockedScenarioId },
        other,
      );
      assert.deepEqual(
        readScenarioFormSubmissions(state, "scenario-2").map(
          (submission) => submission.sourceActionNodeId,
        ),
        ["contact-form"],
      );
    }
  });

  it("replaces an earlier submission of the same form as a whole", async () => {
    const first = await readSubmittedScenarioForm(readParams());
    const second = await readSubmittedScenarioForm(
      readParams({
        flowResponseJson: reply({ size: "0_m" }),
        inboundMessageId: "message-2",
      }),
    );
    const state = withSubmittedScenarioForm(
      withSubmittedScenarioForm({}, first),
      second,
    );
    assert.deepEqual(readScenarioFormSubmissions(state, "scenario-1"), [
      {
        sourceActionNodeId: "order-form",
        flowId: "flow-1",
        inboundMessageId: "message-2",
        submittedAt: "2026-09-30T10:00:00.000Z",
        fields: [
          {
            key: "size",
            label: "Size",
            fieldType: "Dropdown",
            value: "Medium",
          },
        ],
      },
    ]);
  });
});
