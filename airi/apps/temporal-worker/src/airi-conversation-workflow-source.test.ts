import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "workflows",
    "airi-conversation.ts",
  ),
  "utf8",
);
const jobRunnerSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "airi-runtime",
    "src",
    "job-runner.ts",
  ),
  "utf8",
);

test("preserves projection read ordering across patch marker states", () => {
  assert.match(
    source,
    /READ_PROJECTION_BEFORE_TIMER_PATCH_ID\s*=\s*"airi-conversation-read-projection-before-plan-timer"/,
  );
  assert.match(
    source,
    /PLAN_TIMER_WITH_PROJECTION_PATCH_ID\s*=\s*"airi-conversation-plan-timer-with-projection"/,
  );

  const splitActivitiesBody = source.match(
    /async function executeTurnWithSplitActivities\([\s\S]*?function timersEqual/,
  )?.[0];

  assert.ok(splitActivitiesBody, "executeTurnWithSplitActivities is present");
  assert.doesNotMatch(
    splitActivitiesBody,
    /if\s*\(\s*!patched\(READ_PROJECTION_BEFORE_TIMER_PATCH_ID\)\s*\)/,
  );
  assert.match(
    splitActivitiesBody,
    /if\s*\(\s*patched\(PLAN_TIMER_WITH_PROJECTION_PATCH_ID\)\s*\)[\s\S]*?const timerPlan = await planTimerActivity\(turn\)[\s\S]*?projection: timerPlan\.projection \|\| null/,
  );
  assert.match(
    splitActivitiesBody,
    /const \[projection, timerPlan\] = await Promise\.all\(\[[\s\S]*?readProjectionActivity[\s\S]*?planTimerActivity\(turn\)[\s\S]*?\]\);/,
  );
});

test("keeps delivery finalization compatibility while merging new deliveries", () => {
  assert.match(
    source,
    /MERGED_DELIVERY_FINALIZATION_PATCH_ID\s*=\s*"airi-conversation-merged-delivery-finalization"/,
  );

  const deliveryOwner = source.match(
    /async function executeWorkflowLocalDelivery\([\s\S]*?async function executeTurnWithSplitActivities/,
  )?.[0];

  assert.ok(deliveryOwner, "shared delivery owner is present");
  assert.match(
    deliveryOwner,
    /if\s*\(\s*patched\(MERGED_DELIVERY_FINALIZATION_PATCH_ID\)\s*\)[\s\S]*?deliverOutboundActivity\(mergedRequest\)/,
  );
  assert.match(
    deliveryOwner,
    /deliveryResult = await deliverOutboundActivity\(params\.request\)[\s\S]*?await finalizeOutboundActivity/,
  );
  assert.match(
    deliveryOwner,
    /async function deliverPreparedTurn[\s\S]*?return executeWorkflowLocalDelivery/,
  );
  assert.match(
    source,
    /generativeResultDisposition === "pending_delivery"[\s\S]*?executeWorkflowLocalDelivery/,
  );
});

test("exports runtime query state from compact projection state", () => {
  assert.match(
    source,
    /type WorkflowProjection = Omit<AiriConversationProjection, "updatedAt">/,
  );
  assert.match(source, /type AiriConversationWorkflowState = Omit/);
  assert.match(source, /projection: WorkflowProjection/);
  assert.match(source, /function toRuntimeState/);
  assert.match(
    source,
    /patched\(READ_PROJECTION_BEFORE_TIMER_PATCH_ID\);[\s\S]*?const \[projection, timerPlan\] = await Promise\.all\(\[[\s\S]*?readProjectionActivity[\s\S]*?planTimerActivity\(turn\)[\s\S]*?\]\);/,
  );
});

test("keeps timer wait command shape replay-stable by workflow input", () => {
  assert.match(source, /function normalizeTimerWaitMode/);
  assert.match(
    source,
    /CANCEL_STALE_TIMER_SLEEP_PATCH_ID\s*=\s*"airi-conversation-cancel-stale-timer-sleeps"/,
  );
  assert.match(
    source,
    /value === "condition_timeout" \? "condition_timeout" : "legacy_race"/,
  );
  assert.match(
    source,
    /const hasCancelStaleTimerSleepPatch = patched\([\s\S]*?CANCEL_STALE_TIMER_SLEEP_PATCH_ID[\s\S]*?\);/,
  );
  assert.match(
    source,
    /state\.timerWaitMode === "condition_timeout" \|\|[\s\S]*?hasCancelStaleTimerSleepPatch/,
  );
  assert.match(
    source,
    /if\s*\(\s*shouldUseConditionTimeout\s*\)[\s\S]*?await condition\(signalOrTimerChanged, delayMs\);[\s\S]*?return "continue";/,
  );
  assert.match(
    source,
    /await Promise\.race\(\[sleep\(delayMs\), condition\(signalOrTimerChanged\)\]\);/,
  );
});

test("recovers pending timers after failed turn processing behind a patch", () => {
  assert.match(
    source,
    /PLAN_TIMER_AFTER_FAILED_TURN_PATCH_ID\s*=\s*"airi-conversation-plan-timer-after-failed-turn"/,
  );

  const recoveryBody = source.match(
    /async function recoverTimerAfterFailedTurn\([\s\S]*?async function replanTimerAfterFailedTurn/,
  )?.[0];
  assert.ok(recoveryBody, "recoverTimerAfterFailedTurn is present");
  assert.match(
    recoveryBody,
    /if \(!patched\(PLAN_TIMER_AFTER_FAILED_TURN_PATCH_ID\)\) \{[\s\S]*?return false;[\s\S]*?return replanTimerAfterFailedTurn\(params\)/,
  );

  const replanBody = source.match(
    /async function replanTimerAfterFailedTurn\([\s\S]*?function getTimerDelayMs/,
  )?.[0];
  assert.ok(replanBody, "replanTimerAfterFailedTurn is present");
  assert.doesNotMatch(replanBody, /patched\(/);
  assert.match(
    replanBody,
    /const timerPlan = await planTimerActivity[\s\S]*?const timer = withoutRefiredTimer\([\s\S]*?params\.state,[\s\S]*?params\.turn,[\s\S]*?timerPlan\.timer \|\| null,[\s\S]*?\);[\s\S]*?setActiveTimer\(params\.state, timer, timerPlan\.reason \|\| null\)/,
  );
  assert.match(
    replanBody,
    /catch \(recoveryError\)[\s\S]*?timer recovery failed/,
  );

  assert.match(
    source,
    /const recoveredTimer = await recoverTimerAfterFailedTurn\([\s\S]*?if\s*\(\s*!recoveredTimer\s*\)\s*{[\s\S]*?setActiveTimer\(state, null\);/,
  );
});

test("re-plans the wait after an unretried durable turn failure behind a live-branch patch", () => {
  assert.match(
    source,
    /REPLAN_TIMER_AFTER_UNRETRIED_TURN_FAILURE_PATCH_ID\s*=\s*"airi-conversation-replan-timer-after-unretried-turn-failure-v1"/,
  );
  assert.match(
    source,
    /await recordDisposition\([\s\S]*?nextAttemptAt:[\s\S]*?\}\);\s*if \(dueAtMs !== null\)\s*turnRecovery\.schedule\(\{[\s\S]*?dueAtMs,[\s\S]*?\}\);[\s\S]*?else if \(patched\(REPLAN_TIMER_AFTER_UNRETRIED_TURN_FAILURE_PATCH_ID\)\)\s*await replanTimerAfterFailedTurn\(\{[\s\S]*?turn: nextTurn,[\s\S]*?failureMessage,[\s\S]*?\}\);\s*forceDurableContinueAsNew = !useDurableTurnRecovery;/,
  );
  assert.doesNotMatch(
    source,
    /const \w+\s*=\s*patched\(REPLAN_TIMER_AFTER_UNRETRIED_TURN_FAILURE_PATCH_ID\)/,
  );
});

test("suppresses a timer turn re-arming its own fired timer behind a patch", () => {
  assert.match(
    source,
    /SUPPRESS_TIMER_REFIRE_PATCH_ID\s*=\s*"airi-conversation-suppress-timer-refire-v1"/,
  );
  const guardBody = source.match(
    /function withoutRefiredTimer\([\s\S]*?async function recoverTimerAfterFailedTurn/,
  )?.[0];
  assert.ok(guardBody, "withoutRefiredTimer is present");
  // The marker is written only when a re-fire is actually suppressed.
  assert.match(
    guardBody,
    /timer &&\s*isSyntheticTimerTurn\(turn\) &&\s*timersEqual\(timer, state\.lastFiredTimer \|\| null\) &&\s*patched\(SUPPRESS_TIMER_REFIRE_PATCH_ID\)/,
  );
  assert.match(
    source,
    /if \(prepared\.turn\) \{\s*state\.lastFiredTimer = activeTimer;\s*pendingTurns\.push\(prepared\.turn\);/,
  );
  assert.match(
    source,
    /setActiveTimer\(\s*state,\s*withoutRefiredTimer\(state, nextTurn, result\.timer \|\| null\),\s*result\.timerReason \|\| null,\s*\);/,
  );
  assert.match(
    source,
    /lastFiredTimer: carryoverState\?\.lastFiredTimer \|\| null/,
  );
});

test("runs button taps and content repairs in order only behind a patch", () => {
  assert.match(
    source,
    /IN_ORDER_BUTTON_TAPS_PATCH_ID\s*=\s*"airi-conversation-in-order-button-taps-v1"/,
  );
  // The marker is written only when an ordered turn is queued or awaits a retry.
  assert.match(
    source,
    /const takeTurnsInOrder =\s*\(pendingTurns\.some\(isInOrderTurn\) \|\|[\s\S]*?turnRecovery\.hasUnstartedRetry\([\s\S]*?\)\)\) &&\s*patched\(IN_ORDER_BUTTON_TAPS_PATCH_ID\);/,
  );
  // Only behind the marker does an older tap's retry head the queue.
  assert.match(
    source,
    /const orderedRetry =\s*takeTurnsInOrder && useDurableTurnRecovery && pendingTurns\.length > 0\s*\?\s*turnRecovery\.takeUnstartedRetry\(\(old\) => isInOrderTurn\(old\.turn\)\)\s*:\s*null;/,
  );
  // Without the marker, a replay folds every queued turn into the newest.
  assert.match(
    source,
    /const inOrder =\s*takeTurnsInOrder && !orderedRetry \? dequeueNextTurnInOrder\(\) : null;\s*const coalesced = inOrder\s*\?\s*inOrder\.coalesced\s*:\s*useDurableTurnRecovery && !orderedRetry\s*\?\s*\[\.\.\.pendingTurns\]\s*:\s*\[\];\s*const freshTurn = orderedRetry\s*\?\s*null\s*:\s*inOrder\s*\?\s*inOrder\.turn\s*:\s*dequeueLatestTurn\(\);/,
  );
  assert.match(
    source,
    /turnRecovery\.takeSupersedableRetries\(\s*takeTurnsInOrder \? \(old\) => !isInOrderTurn\(old\.turn\) : undefined,\s*\);/,
  );
});

test("closes idle conversation workflows that have no active timer", () => {
  assert.match(source, /IDLE_CLOSE_TIMEOUT\s*=\s*"30 minutes"/);
  assert.match(
    source,
    /const waitResult = await waitForNextSignalOrTimer[\s\S]*?if\s*\(\s*waitResult === "idle_timeout"\s*\)[\s\S]*?return;/,
  );
});

test("guards malformed turn signals before timer planning", () => {
  assert.match(source, /function isValidTurnSignal/);
  assert.match(
    source,
    /input\.carryover\?\.pendingTurns[\s\S]*?input\.carryover\.pendingTurns\.filter\(isValidTurnSignal\)/,
  );

  const enqueueTurnBody = source.match(
    /const enqueueTurn = \(turn: AiriConversationTurnSignal\) => {[\s\S]*?const enqueueExternalEvent/,
  )?.[0];
  assert.ok(enqueueTurnBody, "enqueueTurn is present");
  assert.match(enqueueTurnBody, /if\s*\(\s*!isValidTurnSignal\(turn\)\s*\)/);

  const dequeueLatestTurnBody = source.match(
    /const dequeueLatestTurn = \(\): AiriConversationTurnSignal \| null => {[\s\S]*?if \(input\.initialTurn\)/,
  )?.[0];
  assert.ok(dequeueLatestTurnBody, "dequeueLatestTurn is present");
  assert.match(
    dequeueLatestTurnBody,
    /while \(pendingTurns\.length > 0 && !latestTurn\)/,
  );
  assert.match(
    dequeueLatestTurnBody,
    /latestTurn = isValidTurnSignal\(candidate\) \? candidate : null/,
  );
});

test("durably retries generative events without delaying a newly pending turn", () => {
  const waitBody = source.match(
    /async function waitForNextSignalOrTimer\([\s\S]*?export async function airiConversationWorkflow/,
  )?.[0];
  assert.ok(waitBody, "waitForNextSignalOrTimer is present");
  assert.match(
    waitBody,
    /if \(useDurableGenerativeEvents \|\| useDurableTurnRecovery\)[\s\S]*?pendingTurns\.length > 0 \|\|[\s\S]*?externalEventLifecycle\.hasReady\(nowMs\)/,
  );
  assert.match(
    waitBody,
    /retryDueAtMs[\s\S]*?Math\.min\([\s\S]*?pendingTurns\.length > 0 \|\|[\s\S]*?externalEventLifecycle\.hasReady\(Date\.now\(\)\)/,
  );

  const mainLoop = source.match(
    /while \(true\) \{[\s\S]*?setWorkflowOptions/,
  )?.[0];
  assert.ok(mainLoop, "workflow main loop is present");
  assert.ok(
    mainLoop.indexOf("externalEventLifecycle.hasReady(Date.now())") <
      mainLoop.indexOf("const freshTurn = "),
    "only ready external work is selected before the ordinary pending turn",
  );
});

test("carries the durable lifecycle snapshot through continue-as-new and restores in-flight work", () => {
  assert.match(
    source,
    /createAiriConversationExternalEventLifecycle\([\s\S]*?input\.carryover\?\.externalEventLifecycle/,
  );
  const continueAsNewBody = source.match(
    /const continueAsNewIfSuggested[\s\S]*?const enqueueTurn/,
  )?.[0];
  assert.ok(continueAsNewBody, "continue-as-new owner is present");
  assert.match(
    continueAsNewBody,
    /const lifecycleSnapshot = externalEventLifecycle\.snapshot\(\)/,
  );
  assert.match(continueAsNewBody, /lifecycleSnapshot\.inFlight !== null/);
  assert.match(continueAsNewBody, /externalEventLifecycle: lifecycleSnapshot/);
});

test("patch-gates legacy generative events into a fresh durable run", () => {
  assert.match(
    source,
    /DURABLE_GENERATIVE_EXTERNAL_EVENTS_PATCH_ID\s*=\s*"airi-conversation-durable-generative-external-events-v1"/,
  );
  assert.match(
    source,
    /!useDurableGenerativeEvents &&[\s\S]*?pendingExternalEvents\.some\(isGenerativeResultEvent\)[\s\S]*?continueAsNewIfSuggested\(true\)/,
  );
  assert.match(
    source,
    /if \(!isGenerativeResultEvent\(event\)\) \{[\s\S]*?seenExternalEventKeys\.add\(eventKey\)/,
  );
});

test("acks generative completion only after terminal delivery and projection refresh", () => {
  const eventBody = source.match(
    /if \(hasReadyExternalEvent\) \{[\s\S]*?await continueAsNewIfSuggested\(forceDurableContinueAsNew\);/,
  )?.[0];
  assert.ok(eventBody, "external event loop is present");
  const deliveryIndex = eventBody.indexOf(
    "executeExternalEventWithDelivery(nextEvent)",
  );
  const projectionIndex = eventBody.indexOf("applyProjection(state");
  const ackIndex = eventBody.indexOf(
    "acknowledgeProcessedGenerativeResult(nextEvent)",
  );
  const completionIndex = eventBody.indexOf(
    "externalEventLifecycle.completeInFlight()",
  );
  assert.ok(
    deliveryIndex >= 0 &&
      projectionIndex > deliveryIndex &&
      ackIndex > projectionIndex &&
      completionIndex > ackIndex,
    "delivery, refresh, ack, and processed commit keep their required order",
  );
  assert.match(
    eventBody,
    /catch \(error\)[\s\S]*?externalEventLifecycle\.failInFlight\([\s\S]*?Date\.now\(\)/,
  );
});

test("patch-gates timer replan retries at the live failure branch", () => {
  assert.match(
    source,
    /DURABLE_TIMER_REPLAN_RETRY_PATCH_ID\s*=\s*"airi-conversation-durable-timer-replan-retry-v1"/,
  );
  const failureBody = source.match(
    /catch \(error\) \{[\s\S]*?state\.lastExecutionError = normalizeErrorMessage\(error\);/,
  )?.[0];
  assert.ok(failureBody, "external event failure branch is present");
  assert.match(
    failureBody,
    /nextEvent\.kind === "timer_replan"[\s\S]*?patched\(DURABLE_TIMER_REPLAN_RETRY_PATCH_ID\)[\s\S]*?externalEventLifecycle\.failInFlight/,
  );
  assert.doesNotMatch(source, /const useDurableTimerReplanRetry\s*=\s*patched/);
});

test("carries a future legacy timer-replan failure into a fresh durable run", () => {
  const eventBody = source.match(
    /if \(hasReadyExternalEvent\) \{[\s\S]*?await continueAsNewIfSuggested\([\s\S]*?\);/,
  )?.[0];
  assert.ok(eventBody, "external event loop is present");
  assert.match(
    eventBody,
    /let forceDurableContinueAsNew = false;[\s\S]*?nextEvent\.kind === "timer_replan"[\s\S]*?patched\(DURABLE_TIMER_REPLAN_RETRY_PATCH_ID\)[\s\S]*?if \(useDurableGenerativeEvents\)[\s\S]*?else if \(retryTimerReplan\)[\s\S]*?pendingExternalEvents\.unshift\(nextEvent\)[\s\S]*?forceDurableContinueAsNew = true/,
  );
  assert.match(
    eventBody,
    /await continueAsNewIfSuggested\(forceDurableContinueAsNew\)/,
  );
  assert.match(
    source,
    /pendingExternalEvents:[\s\S]*?\[\.\.\.pendingExternalEvents\][\s\S]*?seenExternalEventKeys: limitStringArray\(seenExternalEventKeys\)/,
  );
});

test("checks the exact generative claim before handoff and provider dispatch", () => {
  const deliveryBody = jobRunnerSource.match(
    /export async function deliverAiriConversationOutbound\([\s\S]*?export async function finalizeAiriConversationOutbound/,
  )?.[0];
  assert.ok(deliveryBody, "canonical delivery activity is present");
  const guardIndex = deliveryBody.indexOf(
    "resolveGenerativeDeliveryClaimGuard(request)",
  );
  const inspectionIndex = deliveryBody.indexOf(
    "inspectGenerativeDeliveryPreflight({",
  );
  const malformedOwnerIndex = deliveryBody.indexOf(
    'generativePreflight?.classification === "malformed_owner"',
  );
  const handoffIndex = deliveryBody.indexOf(
    "shouldBypassManualHandoffForAiriDelivery(request)",
  );
  const invalidPayloadIndex = deliveryBody.indexOf(
    'generativePreflight?.classification === "invalid_payload"',
  );
  const sendIndex = deliveryBody.indexOf("sendAndPersistOutbound({");
  assert.ok(
    guardIndex >= 0 &&
      inspectionIndex > guardIndex &&
      malformedOwnerIndex > inspectionIndex &&
      handoffIndex > malformedOwnerIndex &&
      invalidPayloadIndex > handoffIndex &&
      sendIndex > invalidPayloadIndex,
    "claim staleness, handoff, payload validity, and provider dispatch keep their required order",
  );
  assert.match(
    deliveryBody,
    /classification === "invalid"[\s\S]*?throw new Error\("Generative result delivery claim is malformed"\)/,
  );
  assert.match(
    deliveryBody,
    /inspectGenerativeDeliveryPreflight[\s\S]*?classification === "stale_claim"[\s\S]*?generative_delivery_claim_stale[\s\S]*?classification: "not_attempted"/,
  );
});
