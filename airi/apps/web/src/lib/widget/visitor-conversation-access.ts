/**
 * Visitor ownership checks for widget conversation endpoints.
 *
 * The public widget client key only identifies a workspace's widget source;
 * it is embedded in every customer website. A conversation is readable or
 * writable through widget endpoints only by the visitor that owns it.
 */

import { readEntityId } from "@/lib/scenarios/task-utils";
import { verifyVisitorToken } from "@/lib/widget/visitor-auth";

/** Header carrying the widget's own visitor id (anonymous UUID or host user id). */
export const WIDGET_VISITOR_ID_HEADER = "x-visitor-id";
const MAX_WIDGET_VISITOR_ID_LENGTH = 256;

export type WidgetConversationOwnershipFields = {
  workspaceId?: string | null;
  channel?: string | null;
  sourceId?: string | null;
  visitor_id?: string | null;
  user?: unknown;
};

export type WidgetVisitorScope = {
  workspaceId: string;
  sourceId: string;
};

export function normalizeWidgetVisitorId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const visitorId = value.trim();
  if (!visitorId || visitorId.length > MAX_WIDGET_VISITOR_ID_LENGTH) {
    return null;
  }
  return visitorId;
}

export function isWidgetConversationOwnedByVisitor(
  conversation: WidgetConversationOwnershipFields,
  scope: WidgetVisitorScope & { visitorIds: readonly string[] }
): boolean {
  if (conversation.workspaceId !== scope.workspaceId) return false;
  if (conversation.channel !== "web_widget") return false;
  // Unassigned legacy conversations acquire their source on the next append.
  if (conversation.sourceId && conversation.sourceId !== scope.sourceId) {
    return false;
  }
  // Legacy widget conversations predate visitor_id and stored the visitor as user.
  const owner =
    conversation.visitor_id?.trim() || readEntityId(conversation.user);
  return Boolean(owner) && scope.visitorIds.includes(owner);
}

/**
 * Visitor ids a widget request can prove. The widget sends its stored visitor
 * id; the visitor token remains accepted for clients that predate that header.
 */
export async function resolveWidgetRequestVisitorIds(
  request: Request,
  scope: WidgetVisitorScope
): Promise<string[]> {
  const visitorIds = new Set<string>();
  const headerVisitorId = normalizeWidgetVisitorId(
    request.headers.get(WIDGET_VISITOR_ID_HEADER)
  );
  if (headerVisitorId) visitorIds.add(headerVisitorId);

  const visitorToken = request.headers.get("x-visitor-token")?.trim();
  if (visitorToken) {
    const visitor = await verifyVisitorToken(visitorToken);
    if (
      visitor &&
      visitor.workspaceId === scope.workspaceId &&
      visitor.sourceId === scope.sourceId
    ) {
      visitorIds.add(visitor.visitorId);
    }
  }

  return [...visitorIds];
}
