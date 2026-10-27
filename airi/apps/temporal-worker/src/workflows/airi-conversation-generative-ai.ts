import type {
  AiriConversationDeferredCommand,
  AiriConversationFinalizeOutboundInput,
  AiriConversationOutboundDeliveryRequest,
  AiriConversationOutboundDeliveryResult,
  AiriConversationPostDeliveryEffect,
  AiriConversationTerminalizeGenerativeAckInput,
} from "@icecore/temporal";
import { TemporalFailure } from "@temporalio/workflow";

export type GenerativeAIDeferredDeliveryDependencies = {
  deliver: (
    request: AiriConversationOutboundDeliveryRequest,
  ) => Promise<AiriConversationOutboundDeliveryResult>;
  finalizeEffects: (
    input: AiriConversationFinalizeOutboundInput,
  ) => Promise<void>;
  startDetachedWorkflow: (input: {
    workflowId: string;
    parentClosePolicy: "ABANDON";
    input: AiriConversationDeferredCommand;
  }) => Promise<void>;
  terminalizeAcceptedExecution: (
    input: AiriConversationTerminalizeGenerativeAckInput,
  ) => Promise<void>;
};

const MAX_CLASSIFIED_DELIVERY_ATTEMPTS = 3;

/** Start generation once; a repeated start for the same execution is a no-op. */
async function startGenerativeAIWorkflow(params: {
  command: AiriConversationDeferredCommand;
  dependencies: Pick<
    GenerativeAIDeferredDeliveryDependencies,
    "startDetachedWorkflow"
  >;
}): Promise<void> {
  try {
    await params.dependencies.startDetachedWorkflow({
      workflowId: params.command.workflowId,
      parentClosePolicy: "ABANDON",
      input: params.command,
    });
  } catch (error) {
    if (
      error instanceof TemporalFailure &&
      error.name === "WorkflowExecutionAlreadyStartedError" &&
      (error as { workflowId?: unknown }).workflowId ===
        params.command.workflowId
    ) {
      return;
    }
    throw error;
  }
}

async function applyGenerativeAIDeferredDelivery(params: {
  command: AiriConversationDeferredCommand;
  delivery: AiriConversationOutboundDeliveryResult;
  dependencies: GenerativeAIDeferredDeliveryDependencies;
}): Promise<void> {
  if (!params.delivery.classification) {
    throw new Error(
      "Generative acknowledgment delivery classification is required",
    );
  }

  if (params.delivery.classification === "sent") {
    await startGenerativeAIWorkflow(params);
    return;
  }

  const manualHandoff =
    params.delivery.classification === "skipped" &&
    params.delivery.skipReason === "manual_handoff_active";
  await params.dependencies.terminalizeAcceptedExecution({
    command: params.command,
    outcome: manualHandoff ? "manual_handoff" : "failure",
  });
}

function withoutPostDeliveryEffects(
  request: AiriConversationOutboundDeliveryRequest,
): AiriConversationOutboundDeliveryRequest {
  const deliveryRequest = { ...request };
  delete deliveryRequest.postDeliveryEffects;
  return deliveryRequest;
}

export async function executeGenerativeAIDeferredDelivery(params: {
  command: AiriConversationDeferredCommand;
  pendingDelivery: AiriConversationOutboundDeliveryRequest | null | undefined;
  postDeliveryEffects?: AiriConversationPostDeliveryEffect[] | null;
  dependencies: GenerativeAIDeferredDeliveryDependencies;
}): Promise<void> {
  // A silent start has no delivery. Histories that recorded an acknowledgment
  // delivery replay through the path below.
  if (!params.pendingDelivery) {
    await startGenerativeAIWorkflow(params);
    return;
  }
  if (params.pendingDelivery.dispatchPolicy !== "at_most_once") {
    throw new Error(
      "Generative deferred command requires an at_most_once pending delivery",
    );
  }

  const deliveryRequest = withoutPostDeliveryEffects(params.pendingDelivery);
  const effects =
    params.postDeliveryEffects ??
    params.pendingDelivery.postDeliveryEffects ??
    [];
  let delivery: AiriConversationOutboundDeliveryResult | null = null;

  for (
    let attempt = 0;
    attempt < MAX_CLASSIFIED_DELIVERY_ATTEMPTS;
    attempt += 1
  ) {
    delivery = await params.dependencies.deliver(deliveryRequest);
    if (delivery.classification) {
      break;
    }
  }

  if (!delivery?.classification) {
    throw new Error(
      `Generative acknowledgment delivery remained unclassified after ${MAX_CLASSIFIED_DELIVERY_ATTEMPTS} attempts`,
    );
  }

  if (delivery.classification === "sent" && effects.length > 0) {
    await params.dependencies.finalizeEffects({
      delivery,
      effects,
    });
  }

  await applyGenerativeAIDeferredDelivery({
    command: params.command,
    delivery,
    dependencies: params.dependencies,
  });
}
