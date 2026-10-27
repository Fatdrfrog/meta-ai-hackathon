/**
 * The Airi chat service API used by the routes. The turn itself lives in
 * ./turn: engine.ts orchestrates one turn, handlers/ hold one step per
 * intent, failure.ts maps errors to the saved failure reply, deadline.ts
 * gives every step its share of the turn's time.
 */

export {
  appendAiriChatTurn,
  createAndAppendAiriChatTurn,
  generateAiriChatReply,
} from "./turn/engine";
export {
  archiveAiriChatThreadForUser,
  buildAiriChatTitle,
  clampAiriChatReplyForStorage,
  countSuccessfulAiriChatAnswers,
  createAiriChatThread,
  getAiriChatThreadForUser,
  AIRI_CHAT_TURN_HISTORY_PROJECTION,
  AIRI_CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
  AIRI_CHAT_MESSAGE_PAGE_MAX_LIMIT,
  listAiriChatMessagePage,
  listAiriChatMessages,
  listAiriChatThreads,
  listAiriChatTurnHistory,
  type AiriChatThreadDocument,
} from "./turn/persistence";
export {
  confirmAiriChatMetaAdsMcpMutation,
  reconcileAiriChatMetaAdsMcpMutation,
} from "./turn/meta-mutations";
export { AIRI_CHAT_DELTA_THROTTLE_MS } from "./turn/progress";
export {
  AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS,
  AIRI_CHAT_LOCAL_RETRIEVAL_TIMEOUT_MS,
  searchWorkspaceContextForAiriChat,
  type AiriChatWorkspaceRetrieval,
} from "./turn/retrieval";
export {
  serializeAiriChatMessage,
  serializeAiriChatThread,
  type PublicMetaAdsMcpExecution,
} from "./turn/serialization";
export { generateAiriChatTitle } from "./turn/title";
export type {
  SerializedAiriChatMessage,
  SerializedAiriChatThread,
} from "./turn/types";
