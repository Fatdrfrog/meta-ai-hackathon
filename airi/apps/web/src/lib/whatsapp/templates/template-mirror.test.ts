const mockUpdateOne = jest.fn();
const mockDeleteMany = jest.fn();
jest.mock("@/lib/whatsapp/templates/catalog-cache", () => ({
  patchWhatsAppTemplateCatalogState: jest.fn(),
}));

jest.mock("@/lib/mongoose", () => ({
  connectDB: jest.fn(async () => undefined),
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import {
  deleteTemplateSnapshots,
  fetchWhatsAppTemplateById,
  mergeMetaTemplateIntoUnifiedData,
  mirrorWhatsAppTemplate,
  mirrorWhatsAppTemplatesToUnifiedRows,
  patchWhatsAppTemplateCatalogState,
} from "@/lib/whatsapp/templates/template-mirror";

import { patchWhatsAppTemplateCatalogState as canonicalCatalogPatch } from "@/lib/whatsapp/templates/catalog-cache";
import type { WhatsAppTemplateData } from "@icecore/shared/types/templates";
import type {
  WhatsAppComponent,
  WhatsAppTemplate,
} from "@icecore/shared/types/whatsapp";
import type { SupabaseClient } from "@supabase/supabase-js";

it("exposes the existing catalog lifecycle patch through the canonical template mirror", () => {
  expect(patchWhatsAppTemplateCatalogState).toBe(canonicalCatalogPatch);
});

const FLOW_COMPONENTS: WhatsAppComponent[] = [
  { type: "BODY", text: "Choose a sport" },
  {
    type: "BUTTONS",
    buttons: [
      {
        type: "FLOW",
        text: "Choose",
        flow_id: "1571793974235171",
        flow_action: "navigate",
        navigate_screen: "QUESTION_ONE",
      },
    ],
  },
];

const QUICK_REPLY_COMPONENTS: WhatsAppComponent[] = [
  { type: "BODY", text: "Choose a sport" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Choose" }] },
];

const STORED: WhatsAppTemplateData = {
  language: "kk",
  category: "MARKETING",
  components: FLOW_COMPONENTS,
  metaTemplateId: "2841845149518816",
  status: "PENDING",
  wabaId: "waba-1",
};

const LIVE: WhatsAppTemplate = {
  id: "2841845149518816",
  name: "demoshop_test",
  language: "kk",
  status: "APPROVED",
  category: "MARKETING",
  components: QUICK_REPLY_COMPONENTS,
};

function imageHeader(url: string): WhatsAppComponent {
  return {
    type: "HEADER",
    format: "IMAGE",
    example: { header_handle: [url] },
  };
}

type Row = { id: string; whatsapp_data: unknown };

/** A Supabase stand-in for the select-then-update the mirror runs. */
function fakeSupabase(rows: Row[], options: { failUpdates?: string[] } = {}) {
  const selects: Array<Record<string, unknown>> = [];
  const updates: Array<{ values: unknown; filters: Record<string, unknown> }> =
    [];
  const client = {
    from: (table: string) => {
      expect(table).toBe("message_templates");
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          selects.push(filters);
          const query = {
            eq: (column: string, value: unknown) => {
              filters[column] = value;
              return query;
            },
            in: (column: string, value: unknown) => {
              filters[column] = value;
              return query;
            },
            then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
              resolve({ data: rows, error: null }),
          };
          return query;
        },
        update: (values: unknown) => {
          const filters: Record<string, unknown> = {};
          const query = {
            eq: (column: string, value: unknown) => {
              filters[column] = value;
              if (Object.keys(filters).length === 2) {
                if (options.failUpdates?.includes(String(filters.id))) {
                  return Promise.resolve({ error: { message: "timeout" } });
                }
                updates.push({ values, filters });
                return Promise.resolve({ error: null });
              }
              return query;
            },
          };
          return query;
        },
      };
    },
  };
  return {
    supabase: client as unknown as SupabaseClient,
    selects,
    updates,
  };
}

describe("WhatsApp template mirror", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
  });

  it("replaces the stored status and buttons with Meta's version", () => {
    expect(mergeMetaTemplateIntoUnifiedData(STORED, LIVE)).toEqual({
      ...STORED,
      status: "APPROVED",
      components: QUICK_REPLY_COMPONENTS,
    });
  });

  it("keeps our stored header media link when Meta's header has none", () => {
    const stored = {
      ...STORED,
      components: [
        imageHeader("https://cdn.example.com/a.jpg"),
        ...FLOW_COMPONENTS,
      ],
    };
    const live = {
      ...LIVE,
      components: [
        { type: "HEADER", format: "IMAGE" } as WhatsAppComponent,
        ...QUICK_REPLY_COMPONENTS,
      ],
    };

    expect(mergeMetaTemplateIntoUnifiedData(stored, live).components).toEqual([
      imageHeader("https://cdn.example.com/a.jpg"),
      ...QUICK_REPLY_COMPONENTS,
    ]);
  });

  it("keeps our own sample link over Meta's expiring CDN link", () => {
    const stored = {
      ...STORED,
      components: [
        imageHeader("https://storage.example.com/sample.jpg"),
        ...FLOW_COMPONENTS,
      ],
    };
    const live = {
      ...LIVE,
      components: [
        imageHeader("https://scontent.whatsapp.net/v/t61/sample.jpg?oe=1"),
        ...QUICK_REPLY_COMPONENTS,
      ],
    };

    expect(mergeMetaTemplateIntoUnifiedData(stored, live).components).toEqual([
      imageHeader("https://storage.example.com/sample.jpg"),
      ...QUICK_REPLY_COMPONENTS,
    ]);
  });

  it("takes Meta's link when ours was a CDN link too", () => {
    const stored = {
      ...STORED,
      components: [
        imageHeader("https://scontent.whatsapp.net/old.jpg"),
        ...FLOW_COMPONENTS,
      ],
    };
    const live = {
      ...LIVE,
      components: [
        imageHeader("https://scontent.whatsapp.net/new.jpg"),
        ...QUICK_REPLY_COMPONENTS,
      ],
    };

    expect(mergeMetaTemplateIntoUnifiedData(stored, live).components).toEqual(
      live.components
    );
  });

  it("keeps our own sample link on carousel cards too", () => {
    const card = (url: string) => ({
      components: [
        imageHeader(url),
        { type: "BODY", text: "Card" } as WhatsAppComponent,
      ],
    });
    const carousel = (url: string) =>
      ({ type: "CAROUSEL", cards: [card(url)] }) as WhatsAppComponent;
    const stored = {
      ...STORED,
      components: [carousel("https://storage.example.com/card.jpg")],
    };
    const live = {
      ...LIVE,
      components: [carousel("https://scontent.whatsapp.net/card.jpg?oe=1")],
    };

    expect(mergeMetaTemplateIntoUnifiedData(stored, live).components).toEqual([
      carousel("https://storage.example.com/card.jpg"),
    ]);
  });

  it("drops the stored media header once Meta's template has none", () => {
    const stored = {
      ...STORED,
      components: [
        imageHeader("https://cdn.example.com/a.jpg"),
        ...FLOW_COMPONENTS,
      ],
    };

    expect(mergeMetaTemplateIntoUnifiedData(stored, LIVE).components).toEqual(
      QUICK_REPLY_COMPONENTS
    );
  });

  it("updates only the workspace rows that point at the template", async () => {
    const { supabase, selects, updates } = fakeSupabase([
      { id: "row-1", whatsapp_data: STORED },
      {
        id: "row-2",
        whatsapp_data: { ...STORED, metaTemplateId: "other-template" },
      },
      { id: "row-3", whatsapp_data: null },
    ]);

    const updated = await mirrorWhatsAppTemplatesToUnifiedRows({
      supabase,
      workspaceId: "workspace-1",
      templates: [LIVE],
    });

    expect(updated).toBe(1);
    // One template is looked up by its Meta id, not by reading every row.
    expect(selects).toEqual([
      {
        workspace_id: "workspace-1",
        channel: ["whatsapp", "both"],
        "whatsapp_data->>metaTemplateId": ["2841845149518816"],
      },
    ]);
    expect(updates).toEqual([
      {
        values: {
          whatsapp_data: {
            ...STORED,
            status: "APPROVED",
            components: QUICK_REPLY_COMPONENTS,
          },
        },
        filters: { id: "row-1", workspace_id: "workspace-1" },
      },
    ]);
  });

  it("leaves a row that already matches Meta untouched", async () => {
    const { supabase, updates } = fakeSupabase([
      {
        id: "row-1",
        whatsapp_data: mergeMetaTemplateIntoUnifiedData(STORED, LIVE),
      },
    ]);

    await expect(
      mirrorWhatsAppTemplatesToUnifiedRows({
        supabase,
        workspaceId: "workspace-1",
        templates: [LIVE],
      })
    ).resolves.toBe(0);
    expect(updates).toEqual([]);
  });

  it("refreshes a cached snapshot and the stored rows", async () => {
    const { supabase, updates } = fakeSupabase([
      { id: "row-1", whatsapp_data: STORED },
    ]);

    await expect(
      mirrorWhatsAppTemplate({
        supabase,
        workspaceId: "workspace-1",
        template: LIVE,
      })
    ).resolves.toEqual({ snapshotUpdated: true, unifiedRows: 1, errors: [] });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", templateId: "2841845149518816" },
      {
        $set: expect.objectContaining({
          status: "APPROVED",
          components: QUICK_REPLY_COMPONENTS,
        }),
      }
    );
    expect(updates).toHaveLength(1);
  });

  it("never adds a template to the cache on its own", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
    const { supabase } = fakeSupabase([]);

    await expect(
      mirrorWhatsAppTemplate({
        supabase,
        workspaceId: "workspace-1",
        template: LIVE,
      })
    ).resolves.toEqual({ snapshotUpdated: false, unifiedRows: 0, errors: [] });
    // An update, never an upsert: sends treat cached languages as complete.
    expect(mockUpdateOne.mock.calls[0]).toHaveLength(2);
  });

  it("still writes the stored rows when the cache write fails", async () => {
    mockUpdateOne.mockRejectedValue(new Error("E11000 duplicate key"));
    const { supabase, updates } = fakeSupabase([
      { id: "row-1", whatsapp_data: STORED },
    ]);

    await expect(
      mirrorWhatsAppTemplate({
        supabase,
        workspaceId: "workspace-1",
        template: LIVE,
      })
    ).resolves.toEqual({
      snapshotUpdated: false,
      unifiedRows: 1,
      errors: ["E11000 duplicate key"],
    });
    expect(updates).toHaveLength(1);
  });

  it("keeps the stored status when the read-back carries none", async () => {
    const withoutStatus = { ...LIVE, status: undefined };
    const { supabase, updates } = fakeSupabase([
      { id: "row-1", whatsapp_data: STORED },
    ]);

    await mirrorWhatsAppTemplate({
      supabase,
      workspaceId: "workspace-1",
      template: withoutStatus,
    });

    expect(
      (updates[0]?.values as { whatsapp_data: { status?: string } })
        .whatsapp_data.status
    ).toBe("PENDING");
    expect(mockUpdateOne.mock.calls[0][1].$set).not.toHaveProperty("status");
  });

  it("writes the other rows when one row update fails, then reports it", async () => {
    const { supabase, updates } = fakeSupabase(
      [
        { id: "row-1", whatsapp_data: STORED },
        { id: "row-2", whatsapp_data: STORED },
      ],
      { failUpdates: ["row-1"] }
    );

    await expect(
      mirrorWhatsAppTemplatesToUnifiedRows({
        supabase,
        workspaceId: "workspace-1",
        templates: [LIVE],
      })
    ).rejects.toThrow("row-1: timeout");
    expect(updates.map(update => update.filters.id)).toEqual(["row-2"]);
  });

  it("removes one deleted language by id, or every language by name", async () => {
    await deleteTemplateSnapshots({
      workspaceId: "workspace-1",
      templateId: "t-1",
      name: "promo",
    });
    await deleteTemplateSnapshots({
      workspaceId: "workspace-1",
      name: " promo ",
    });

    expect(mockDeleteMany.mock.calls).toEqual([
      [{ workspaceId: "workspace-1", templateId: "t-1" }],
      [{ workspaceId: "workspace-1", name: "promo" }],
    ]);
  });

  describe("fetchWhatsAppTemplateById", () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("preserves Meta rate-limit code and HTTP status for shared cooldown protection", async () => {
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Too many calls",
                type: "OAuthException",
                code: "80008",
              },
            }),
            { status: 400 }
          )
      ) as typeof fetch;
      await expect(
        fetchWhatsAppTemplateById({
          templateId: "template-1",
          accessToken: "token",
        })
      ).rejects.toMatchObject({ status: 400, metaError: { code: 80008 } });
    });

    it("reads one template with the given token", async () => {
      const fetchMock = jest.fn(
        async () => new Response(JSON.stringify(LIVE), { status: 200 })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        fetchWhatsAppTemplateById({
          templateId: "2841845149518816",
          accessToken: "token-1",
        })
      ).resolves.toEqual(LIVE);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toContain("/2841845149518816?fields=");
      expect(url).toContain("components");
      // quality_rating belongs to phone numbers; Meta rejects it on templates.
      expect(new URL(url).searchParams.get("fields")?.split(",")).not.toContain(
        "quality_rating"
      );
      // A hung Graph read must not hold up a webhook.
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer token-1" })
      );
    });

    it("throws Meta's error message", async () => {
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Unsupported get request" } }),
            { status: 400 }
          )
      ) as unknown as typeof fetch;

      await expect(
        fetchWhatsAppTemplateById({
          templateId: "missing",
          accessToken: "token-1",
        })
      ).rejects.toThrow("Unsupported get request");
    });
  });
});
