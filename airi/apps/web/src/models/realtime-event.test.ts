describe("RealtimeEvent explicit index owner", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("owns exactly the seven live indexes in one shared definition tuple", async () => {
    const { RealtimeEvent, REALTIME_EVENT_INDEX_DEFINITIONS } = await import(
      "./realtime-event"
    );

    expect(REALTIME_EVENT_INDEX_DEFINITIONS).toEqual([
      {
        keys: { eventId: 1 },
        options: {
          unique: true,
          name: "realtime_events_event_id_unique",
        },
      },
      {
        keys: { workspaceId: 1, createdAt: -1 },
        options: { name: "realtime_events_workspace_created_desc" },
      },
      {
        keys: { status: 1, createdAt: 1 },
        options: { name: "realtime_events_status_created" },
      },
      {
        keys: { status: 1, nextAttemptAt: 1, createdAt: 1 },
        options: { name: "realtime_events_status_next_attempt_created" },
      },
      {
        keys: { status: 1, replayLeaseExpiresAt: 1, createdAt: 1 },
        options: { name: "realtime_events_status_replay_lease_created" },
      },
      {
        keys: { dedupeKey: 1, createdAt: -1 },
        options: { name: "realtime_events_dedupe_created_desc" },
      },
      {
        keys: { publishedAt: 1 },
        options: {
          expireAfterSeconds: 604_800,
          name: "realtime_events_published_ttl",
        },
      },
    ]);
    expect(RealtimeEvent.schema.indexes()).toEqual(
      REALTIME_EVENT_INDEX_DEFINITIONS.map(definition => [
        definition.keys,
        { background: true, ...definition.options },
      ])
    );

    for (const path of [
      "eventId",
      "name",
      "workspaceId",
      "conversationId",
      "channel",
      "dedupeKey",
      "status",
      "replayLeaseId",
      "replayLeaseExpiresAt",
      "nextAttemptAt",
    ]) {
      expect(RealtimeEvent.schema.path(path).options.index).toBeUndefined();
    }
  });

  it("coalesces concurrent explicit creation and caches success", async () => {
    const { RealtimeEvent, ensureRealtimeEventIndexes } = await import(
      "./realtime-event"
    );
    const createIndex = jest
      .spyOn(RealtimeEvent.collection, "createIndex")
      .mockResolvedValue("created");

    await Promise.all([
      ensureRealtimeEventIndexes(),
      ensureRealtimeEventIndexes(),
      ensureRealtimeEventIndexes(),
    ]);
    await ensureRealtimeEventIndexes();

    expect(createIndex).toHaveBeenCalledTimes(7);
  });

  it("rejects an index failure and lets the next invocation retry", async () => {
    const { RealtimeEvent, ensureRealtimeEventIndexes } = await import(
      "./realtime-event"
    );
    const createIndex = jest
      .spyOn(RealtimeEvent.collection, "createIndex")
      .mockRejectedValueOnce(new Error("index denied"))
      .mockResolvedValue("created");

    await expect(ensureRealtimeEventIndexes()).rejects.toThrow("index denied");
    await expect(ensureRealtimeEventIndexes()).resolves.toBeUndefined();

    expect(createIndex).toHaveBeenCalledTimes(14);
  });
});
