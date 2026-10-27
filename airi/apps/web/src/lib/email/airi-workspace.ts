import "server-only";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

export const DEFAULT_AIRI_REGISTRATION_FOLLOW_UP_WORKSPACE_ID =
  "41b51d55-697c-4455-875a-9a7238bdf272";

export function getAiriRegistrationFollowUpWorkspaceId(): string {
  return (
    readTrimmedString(process.env.AIRI_REGISTRATION_FOLLOW_UP_WORKSPACE_ID) ||
    DEFAULT_AIRI_REGISTRATION_FOLLOW_UP_WORKSPACE_ID
  );
}
