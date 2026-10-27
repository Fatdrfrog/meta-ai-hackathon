import {
  buildRealtimeChannelName,
  buildRealtimeEvent,
  isRealtimeClientFrame,
  isRealtimeEventEnvelope,
  parseProjectionGeneration,
  parseRealtimeChannelName,
  realtimeChannelMatchesScope,
  realtimeScopeCanSubscribe,
} from "@icecore/shared/types/realtime";

describe("shared realtime contracts", () => {
  it("accepts workspace campaign delivery invalidations", () => {
    expect(
      isRealtimeEventEnvelope(
        buildRealtimeEvent({
          eventId: "campaign-event",
          name: "campaign.delivery.changed",
          workspaceId: "workspace_1",
          dedupeKey: "campaign-event",
          createdAt: "2026-09-15T10:00:00.000Z",
          payload: { campaignId: "campaign_1" },
        })
      )
    ).toBe(true);
  });
  it("re-exports closed Requests realtime contracts without changing legacy scopes", () => {
    expect(parseProjectionGeneration("42")).toBe("42");
    expect(() => parseProjectionGeneration("042")).toThrow();
  });

  it("builds small typed conversation events with stable channel names", () => {
    const event = buildRealtimeEvent({
      eventId: "evt_1",
      name: "conversation.message.created",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      dedupeKey: "message:507f1f77bcf86cd799439011:created",
      createdAt: "2026-06-19T00:00:00.000Z",
      payload: { messageId: "507f1f77bcf86cd799439012" },
    });

    expect(event.version).toBe(1);
    expect(event.name).toBe("conversation.message.created");
    expect(event.payload).toEqual({
      messageId: "507f1f77bcf86cd799439012",
    });
    expect(isRealtimeEventEnvelope(event)).toBe(true);
    expect(
      buildRealtimeChannelName({
        kind: "conversation",
        workspaceId: "workspace_1",
        conversationId: "507f1f77bcf86cd799439011",
      })
    ).toBe("conversation:workspace_1:507f1f77bcf86cd799439011");
  });

  it("accepts compact call session update events", () => {
    const event = buildRealtimeEvent({
      eventId: "evt_call_1",
      name: "conversation.call.updated",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      dedupeKey: "call:507f1f77bcf86cd799439011:session_1:incoming",
      createdAt: "2026-06-19T00:01:00.000Z",
      payload: {
        callSessionId: "session_1",
        state: "incoming",
      },
    });

    expect(event.payload).toEqual({
      callSessionId: "session_1",
      state: "incoming",
    });
    expect(isRealtimeEventEnvelope(event)).toBe(true);
  });

  it("accepts call command refresh events", () => {
    const event = buildRealtimeEvent({
      eventId: "evt_call_command_1",
      name: "conversation.call.updated",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      dedupeKey: "call:507f1f77bcf86cd799439011:session_1:incoming:command_1",
      createdAt: "2026-06-19T00:01:01.000Z",
      payload: {
        callSessionId: "session_1",
        state: "incoming",
        reason: "command",
      },
    });

    expect(event.payload).toEqual({
      callSessionId: "session_1",
      state: "incoming",
      reason: "command",
    });
    expect(isRealtimeEventEnvelope(event)).toBe(true);
  });

  it("accepts CRM board invalidation events on the workspace channel", () => {
    const event = buildRealtimeEvent({
      eventId: "evt_crm_1",
      name: "crm.board.changed",
      workspaceId: "workspace_1",
      conversationId: null,
      dedupeKey:
        "crm.board.changed:workspace_1:pipeline_saved:pipeline:evt_crm_1",
      createdAt: "2026-08-28T12:00:00.000Z",
      payload: { reason: "pipeline_saved" },
    });

    expect(isRealtimeEventEnvelope(event)).toBe(true);
    expect(
      buildRealtimeChannelName({
        kind: "workspace",
        workspaceId: "workspace_1",
      })
    ).toBe("workspace:workspace_1");
  });

  it("accepts subscribe and unsubscribe client frames only for valid channels", () => {
    expect(
      isRealtimeClientFrame({
        type: "subscribe",
        channels: ["workspace:workspace_1"],
      })
    ).toBe(true);

    expect(
      isRealtimeClientFrame({
        type: "unsubscribe",
        channels: ["conversation:workspace_1:507f1f77bcf86cd799439011"],
      })
    ).toBe(true);

    expect(
      isRealtimeClientFrame({
        type: "subscribe",
        channels: ["tenant-workspace_1"],
      })
    ).toBe(false);
  });

  it("parses realtime channel names for observability", () => {
    expect(parseRealtimeChannelName("workspace:workspace_1")).toEqual({
      kind: "workspace",
      workspaceId: "workspace_1",
      conversationId: null,
    });

    expect(
      parseRealtimeChannelName(
        "conversation:workspace_1:507f1f77bcf86cd799439011"
      )
    ).toEqual({
      kind: "conversation",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
    });

    expect(parseRealtimeChannelName("tenant-workspace_1")).toEqual({
      kind: "unknown",
      workspaceId: null,
      conversationId: null,
    });
  });

  it("authorizes workspace tokens for only the exact workspace channel", () => {
    expect(
      realtimeScopeCanSubscribe("workspace:workspace_1", {
        kind: "workspace",
        workspaceId: "workspace_1",
      })
    ).toBe(true);
    expect(
      realtimeScopeCanSubscribe(
        "conversation:workspace_1:507f1f77bcf86cd799439011",
        {
          kind: "workspace",
          workspaceId: "workspace_1",
        }
      )
    ).toBe(false);

    expect(
      realtimeScopeCanSubscribe(
        "conversation:workspace_2:507f1f77bcf86cd799439011",
        {
          kind: "workspace",
          workspaceId: "workspace_1",
        }
      )
    ).toBe(false);
  });

  it("keeps conversation authorization and the existing matcher exact", () => {
    const conversationScope = {
      kind: "conversation" as const,
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
    };
    expect(
      realtimeScopeCanSubscribe(
        "conversation:workspace_1:507f1f77bcf86cd799439011",
        conversationScope
      )
    ).toBe(true);

    expect(
      realtimeScopeCanSubscribe("workspace:workspace_1", conversationScope)
    ).toBe(false);

    expect(
      realtimeChannelMatchesScope("workspace:workspace_1", {
        kind: "workspace",
        workspaceId: "workspace_1",
      })
    ).toBe(true);
    expect(
      realtimeChannelMatchesScope(
        "conversation:workspace_1:507f1f77bcf86cd799439011",
        { kind: "workspace", workspaceId: "workspace_1" }
      )
    ).toBe(false);
    expect(
      realtimeChannelMatchesScope(
        "conversation:workspace_1:507f1f77bcf86cd799439011",
        conversationScope
      )
    ).toBe(true);
  });
});
