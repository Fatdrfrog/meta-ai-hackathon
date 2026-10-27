import {
  SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION,
  SCENARIO_LEGACY_ACTION_ROUTING_SOURCE_KINDS,
  type ScenarioActionOutcomeBranchKey,
} from "./scenario-action-routing";
import { SCENARIO_ACTION_OUTCOME_VIRTUAL_NODE_DATA } from "./scenario-routing-compiler";
import {
  SCENARIO_LOGIC_TYPES,
  SCENARIO_POST_ACTION_CONDITION_TYPES,
  type ScenarioPostActionConditionType,
} from "./scenario-triggers";

const frozenLogicTypes: readonly [
  "audience_filter",
  "post_action_condition",
  "recipient_column_split",
] = SCENARIO_LOGIC_TYPES;

const frozenPostActionConditionTypes: readonly [
  "user_replied",
  "payment_detected",
  "no_reply_timeout",
] = SCENARIO_POST_ACTION_CONDITION_TYPES;

const frozenLegacyProjectorSourceKinds: readonly [
  "post_action_condition",
  "audience_filter",
] = SCENARIO_LEGACY_ACTION_ROUTING_SOURCE_KINDS;

const frozenVirtualLogicType: "post_action_condition" =
  SCENARIO_ACTION_OUTCOME_VIRTUAL_NODE_DATA.logicType;

const outcomeKeyToCondition: Record<
  ScenarioActionOutcomeBranchKey,
  ScenarioPostActionConditionType
> = SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION;

void frozenLogicTypes;
void frozenPostActionConditionTypes;
void frozenLegacyProjectorSourceKinds;
void frozenVirtualLogicType;
void outcomeKeyToCondition;
