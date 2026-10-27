import "server-only";

import { getTemporalClient } from "./client";
import type { TemporalScheduleClient } from "./sdk-types";

export function getTemporalScheduleClient(): TemporalScheduleClient {
  return getTemporalClient().schedule;
}
