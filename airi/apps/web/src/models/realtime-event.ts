import mongoose from "mongoose";

type RealtimeEventIndexKeys = Record<string, 1 | -1>;
type RealtimeEventIndexOptions = {
  name: string;
  unique?: boolean;
  expireAfterSeconds?: number;
};
type RealtimeEventIndexDefinition = {
  keys: RealtimeEventIndexKeys;
  options: RealtimeEventIndexOptions;
};

export const REALTIME_EVENT_EVENT_ID_UNIQUE_INDEX_NAME =
  "realtime_events_event_id_unique";
export const REALTIME_EVENT_WORKSPACE_CREATED_INDEX_NAME =
  "realtime_events_workspace_created_desc";
export const REALTIME_EVENT_STATUS_CREATED_INDEX_NAME =
  "realtime_events_status_created";
export const REALTIME_EVENT_STATUS_NEXT_ATTEMPT_CREATED_INDEX_NAME =
  "realtime_events_status_next_attempt_created";
export const REALTIME_EVENT_STATUS_REPLAY_LEASE_CREATED_INDEX_NAME =
  "realtime_events_status_replay_lease_created";
export const REALTIME_EVENT_DEDUPE_CREATED_INDEX_NAME =
  "realtime_events_dedupe_created_desc";
export const REALTIME_EVENT_PUBLISHED_TTL_INDEX_NAME =
  "realtime_events_published_ttl";
export const REALTIME_EVENT_PUBLISHED_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export const REALTIME_EVENT_EVENT_ID_UNIQUE_INDEX_KEYS: RealtimeEventIndexKeys =
  {
    eventId: 1,
  };
export const REALTIME_EVENT_WORKSPACE_CREATED_INDEX_KEYS: RealtimeEventIndexKeys =
  {
    workspaceId: 1,
    createdAt: -1,
  };
export const REALTIME_EVENT_STATUS_CREATED_INDEX_KEYS: RealtimeEventIndexKeys =
  {
    status: 1,
    createdAt: 1,
  };
export const REALTIME_EVENT_STATUS_NEXT_ATTEMPT_CREATED_INDEX_KEYS: RealtimeEventIndexKeys =
  {
    status: 1,
    nextAttemptAt: 1,
    createdAt: 1,
  };
export const REALTIME_EVENT_STATUS_REPLAY_LEASE_CREATED_INDEX_KEYS: RealtimeEventIndexKeys =
  {
    status: 1,
    replayLeaseExpiresAt: 1,
    createdAt: 1,
  };
export const REALTIME_EVENT_DEDUPE_CREATED_INDEX_KEYS: RealtimeEventIndexKeys =
  {
    dedupeKey: 1,
    createdAt: -1,
  };
export const REALTIME_EVENT_PUBLISHED_TTL_INDEX_KEYS: RealtimeEventIndexKeys = {
  publishedAt: 1,
};

export const REALTIME_EVENT_INDEX_DEFINITIONS: RealtimeEventIndexDefinition[] =
  [
    {
      keys: REALTIME_EVENT_EVENT_ID_UNIQUE_INDEX_KEYS,
      options: {
        unique: true,
        name: REALTIME_EVENT_EVENT_ID_UNIQUE_INDEX_NAME,
      },
    },
    {
      keys: REALTIME_EVENT_WORKSPACE_CREATED_INDEX_KEYS,
      options: { name: REALTIME_EVENT_WORKSPACE_CREATED_INDEX_NAME },
    },
    {
      keys: REALTIME_EVENT_STATUS_CREATED_INDEX_KEYS,
      options: { name: REALTIME_EVENT_STATUS_CREATED_INDEX_NAME },
    },
    {
      keys: REALTIME_EVENT_STATUS_NEXT_ATTEMPT_CREATED_INDEX_KEYS,
      options: { name: REALTIME_EVENT_STATUS_NEXT_ATTEMPT_CREATED_INDEX_NAME },
    },
    {
      keys: REALTIME_EVENT_STATUS_REPLAY_LEASE_CREATED_INDEX_KEYS,
      options: { name: REALTIME_EVENT_STATUS_REPLAY_LEASE_CREATED_INDEX_NAME },
    },
    {
      keys: REALTIME_EVENT_DEDUPE_CREATED_INDEX_KEYS,
      options: { name: REALTIME_EVENT_DEDUPE_CREATED_INDEX_NAME },
    },
    {
      keys: REALTIME_EVENT_PUBLISHED_TTL_INDEX_KEYS,
      options: {
        expireAfterSeconds: REALTIME_EVENT_PUBLISHED_RETENTION_SECONDS,
        name: REALTIME_EVENT_PUBLISHED_TTL_INDEX_NAME,
      },
    },
  ];

const RealtimeEventSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    eventId: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    name: { type: String, required: true },
    workspaceId: { type: String, required: true },
    conversationId: { type: String, default: null },
    channel: { type: String, required: true },
    dedupeKey: { type: String, required: true },
    event: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["pending", "replaying", "published", "failed"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    messageId: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    replayLeaseId: { type: String, default: null },
    replayLeaseExpiresAt: { type: Date, default: null },
    lastReplayAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

for (const definition of REALTIME_EVENT_INDEX_DEFINITIONS) {
  RealtimeEventSchema.index({ ...definition.keys }, { ...definition.options });
}

export const RealtimeEvent =
  mongoose.models.RealtimeEvent ||
  mongoose.model("RealtimeEvent", RealtimeEventSchema);

let realtimeEventIndexPromise: Promise<void> | null = null;
let realtimeEventIndexesEnsured = false;

export async function ensureRealtimeEventIndexes(): Promise<void> {
  if (realtimeEventIndexesEnsured) {
    return;
  }

  if (!realtimeEventIndexPromise) {
    realtimeEventIndexPromise = Promise.all(
      REALTIME_EVENT_INDEX_DEFINITIONS.map(definition =>
        RealtimeEvent.collection.createIndex(definition.keys, {
          background: true,
          ...definition.options,
        })
      )
    )
      .then(() => {
        realtimeEventIndexesEnsured = true;
      })
      .finally(() => {
        realtimeEventIndexPromise = null;
      });
  }

  return realtimeEventIndexPromise;
}
