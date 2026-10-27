import type {
  AiriConversationTurnDisposition,
  AiriConversationTurnProcessResult,
  AiriConversationTurnReference,
} from "@icecore/temporal";

export type AiriTurnPreparationClaim = {
  status: "claimed";
  turnContextId: string;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  attemptToken: string;
};

/** Mongo ownership is supplied by the worker composition root per invocation. */
export interface AiriTurnExecutionStore {
  claimAiriTurnPreparation(
    turn: AiriConversationTurnReference,
  ): Promise<
    | AiriTurnPreparationClaim
    | { status: "prepared"; result: AiriConversationTurnProcessResult }
    | { status: "outcome_unknown" | "terminal" }
  >;
  completeAiriTurnPreparation(
    claim: AiriTurnPreparationClaim,
    result: AiriConversationTurnProcessResult,
  ): Promise<void>;
  failAiriTurnPreparation(
    claim: AiriTurnPreparationClaim,
    error: string,
    safeToRetry: boolean,
  ): Promise<void>;
  recordAiriConversationTurnDisposition(
    receipt: AiriConversationTurnDisposition,
  ): Promise<void>;
}

/** Only the read-only hydration boundary may produce this error. */
export class AiriTurnPreparationNotStartedError extends Error {
  readonly preparationNotStarted = true;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AiriTurnPreparationNotStartedError";
  }
}

export function isAiriTurnPreparationNotStartedError(
  error: unknown,
): error is AiriTurnPreparationNotStartedError {
  return (
    error instanceof Error &&
    "preparationNotStarted" in error &&
    error.preparationNotStarted === true
  );
}

export async function runAiriTurnPreflight<T>(
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new AiriTurnPreparationNotStartedError(error);
  }
}
