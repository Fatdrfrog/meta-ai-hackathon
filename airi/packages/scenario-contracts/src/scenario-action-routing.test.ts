import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION,
  SCENARIO_ACTION_OUTCOME_VIRTUAL_NODE_DATA,
  SCENARIO_LEGACY_ACTION_ROUTING_SOURCE_KINDS,
  SCENARIO_LOGIC_TYPES,
  SCENARIO_POST_ACTION_CONDITION_TYPES,
  visitScenarioActionOutcomeBranches,
} from "./index.ts";

describe("frozen scenario action routing catalogs", () => {
  it("keeps logic, post-action, and legacy projector kinds closed", () => {
    assert.deepEqual([...SCENARIO_LOGIC_TYPES], [
      "audience_filter",
      "post_action_condition",
      "recipient_column_split",
    ]);
    assert.deepEqual([...SCENARIO_POST_ACTION_CONDITION_TYPES], [
      "user_replied",
      "payment_detected",
      "no_reply_timeout",
    ]);
    assert.deepEqual([...SCENARIO_LEGACY_ACTION_ROUTING_SOURCE_KINDS], [
      "post_action_condition",
      "audience_filter",
    ]);
    assert.equal(
      SCENARIO_ACTION_OUTCOME_VIRTUAL_NODE_DATA.logicType,
      "post_action_condition",
    );
  });

  it("maps every action-outcome branch onto a frozen post-action type", () => {
    assert.deepEqual(SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION, {
      anyReply: "user_replied",
      noReply: "no_reply_timeout",
      answerMatches: "no_reply_timeout",
      paymentDetected: "payment_detected",
      branchDelays: "no_reply_timeout",
      locationRoutes: "user_replied",
    });

    const visited: string[] = [];
    visitScenarioActionOutcomeBranches({
      anyReply: () => {
        visited.push("anyReply");
      },
      noReply: () => {
        visited.push("noReply");
      },
      answerMatches: () => {
        visited.push("answerMatches");
      },
      paymentDetected: () => {
        visited.push("paymentDetected");
      },
      branchDelays: () => {
        visited.push("branchDelays");
      },
      locationRoutes: () => {
        visited.push("locationRoutes");
      },
    });
    assert.deepEqual(visited, [
      "anyReply",
      "noReply",
      "answerMatches",
      "paymentDetected",
      "branchDelays",
      "locationRoutes",
    ]);
  });
});
