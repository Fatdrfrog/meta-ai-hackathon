const mockArtifactCreate = jest.fn();
const mockArtifactFindOne = jest.fn();
const mockArtifactFind = jest.fn();
const mockArtifactFindOneAndUpdate = jest.fn();
const mockArtifactVersionCreate = jest.fn();
const mockCreateUnifiedTemplateRecord = jest.fn();
const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockCreateMetaWhatsAppFlow = jest.fn();
const mockUpdateMetaWhatsAppFlow = jest.fn();
const mockCreativeAssetFindOne = jest.fn();
const mockResolveCreativeAssetDisplayUrl = jest.fn();

jest.mock("@/models/airi-artifact", () => ({
  AiriArtifact: {
    create: (...args: unknown[]) => mockArtifactCreate(...args),
    find: (...args: unknown[]) => mockArtifactFind(...args),
    findOne: (...args: unknown[]) => mockArtifactFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockArtifactFindOneAndUpdate(...args),
  },
  AiriArtifactVersion: {
    create: (...args: unknown[]) => mockArtifactVersionCreate(...args),
  },
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockCreativeAssetFindOne(...args),
  },
}));

jest.mock("@/lib/higgsfield/creative-asset-serialization", () => ({
  resolveCreativeAssetDisplayUrl: (...args: unknown[]) =>
    mockResolveCreativeAssetDisplayUrl(...args),
}));

jest.mock("@/lib/whatsapp/templates/unified-service", () => ({
  createUnifiedTemplateRecord: (...args: unknown[]) =>
    mockCreateUnifiedTemplateRecord(...args),
}));

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/flows/service", () => ({
  createMetaWhatsAppFlow: (...args: unknown[]) =>
    mockCreateMetaWhatsAppFlow(...args),
  updateMetaWhatsAppFlow: (...args: unknown[]) =>
    mockUpdateMetaWhatsAppFlow(...args),
}));

import {
  AiriArtifactConflictError,
  createAiriArtifact,
  submitAiriArtifact,
  updateAiriArtifact,
} from "./service";

const templateDraft = {
  kind: "whatsapp_template" as const,
  name: "airi_template",
  language: "en",
  category: "MARKETING" as const,
  components: [{ type: "BODY" as const, text: "Hi {{1}}" }],
};

const flowConfig = {
  templateId: "lead_generation",
  ctaText: "Start",
  bodyText: "Please complete this form.",
  flowUiLocale: "en" as const,
  screens: [
    {
      id: "LEAD_FORM",
      title: "Lead form",
      fields: [
        {
          id: "name",
          label: "Name",
          fieldType: "TextInput" as const,
          required: true,
        },
      ],
    },
  ],
};

const campaignPackage = {
  title: "Pricing lead win-back",
  goal: "Recover warm leads who asked about pricing.",
  audience: "Warm WhatsApp leads",
  angle: "Helpful follow-up with one clear reply",
  evidence: ["Recent conversations mention pricing."],
  tools: {
    whatsapp: { available: true, label: "WhatsApp" },
    scenarios: { available: true, label: "Scenarios" },
    bulkCampaigns: { available: true, label: "Bulk campaigns" },
    canva: { available: false, label: "Canva" },
    visualGeneration: { available: false, label: "Visual generation" },
    audioGeneration: { available: false, label: "Audio generation" },
    metaAds: { available: false, label: "Meta Ads" },
  },
  steps: [
    {
      id: "template",
      kind: "whatsapp_template" as const,
      title: "Draft WhatsApp template",
      description: "Create a compliant re-engagement template.",
      status: "ready" as const,
      tool: "whatsapp" as const,
    },
  ],
  checks: [{ label: "Human approval", status: "pending" as const }],
  nextAction: "Review the WhatsApp template.",
};

function leanDoc(doc: Record<string, unknown>) {
  return {
    ...doc,
    _id: doc._id || "artifact-1",
    createdAt: doc.createdAt || new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: doc.updatedAt || new Date("2026-06-01T00:00:00.000Z"),
  };
}

function chain<T>(value: T) {
  return {
    sort: jest.fn(() => ({
      limit: jest.fn(() => ({
        lean: jest.fn(async () => value),
      })),
    })),
    lean: jest.fn(async () => value),
  };
}

function selectChain<T>(value: T) {
  return {
    select: jest.fn(() => ({
      lean: jest.fn(async () => value),
    })),
  };
}

describe("Airi durable artifacts service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreativeAssetFindOne.mockReset();
    mockResolveCreativeAssetDisplayUrl.mockReset();
  });

  it("creates a template artifact with revision zero and an initial version", async () => {
    mockArtifactCreate.mockImplementation(async payload =>
      leanDoc({ ...payload, _id: "artifact-1" })
    );

    const artifact = await createAiriArtifact({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "whatsapp_template",
      snapshot: { templateDraft },
      sourceMessageId: "message-1",
    });

    expect(mockArtifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        createdByUserId: "user-1",
        kind: "whatsapp_template",
        revision: 0,
        snapshot: {
          templateDraft: expect.objectContaining({
            name: "airi_template",
            components: expect.arrayContaining([
              expect.objectContaining({ type: "BODY", text: "Hi {{1}}" }),
            ]),
          }),
        },
        source: expect.objectContaining({ messageId: "message-1" }),
      })
    );
    expect(mockArtifactVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-1",
        workspaceId: "workspace-1",
        revision: 0,
        snapshot: {
          templateDraft: expect.objectContaining({
            name: "airi_template",
          }),
        },
      })
    );
    expect(artifact).toEqual(
      expect.objectContaining({
        id: "artifact-1",
        kind: "whatsapp_template",
        revision: 0,
        validation: expect.objectContaining({ status: "valid" }),
      })
    );
  });

  it("creates a marketing campaign artifact with revision zero", async () => {
    mockArtifactCreate.mockImplementation(async payload =>
      leanDoc({ ...payload, _id: "campaign-artifact-1" })
    );

    const artifact = await createAiriArtifact({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "marketing_campaign",
      snapshot: { campaignPackage },
      sourceMessageId: "message-1",
    });

    expect(mockArtifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        kind: "marketing_campaign",
        title: "Pricing lead win-back",
        revision: 0,
        snapshot: {
          campaignPackage: expect.objectContaining({
            title: "Pricing lead win-back",
          }),
        },
      })
    );
    expect(mockArtifactVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "campaign-artifact-1",
        kind: "marketing_campaign",
        revision: 0,
      })
    );
    expect(artifact).toEqual(
      expect.objectContaining({
        id: "campaign-artifact-1",
        kind: "marketing_campaign",
        revision: 0,
        validation: expect.objectContaining({ status: "valid" }),
      })
    );
  });

  it("rejects invalid template snapshots before touching persistence", async () => {
    await expect(
      createAiriArtifact({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
        kind: "whatsapp_template",
        snapshot: {
          templateDraft: {
            ...templateDraft,
            components: Array.from({ length: 9 }, (_, index) => ({
              type: "BODY" as const,
              text: `Body ${index}`,
            })),
          },
        },
      })
    ).rejects.toThrow(/Invalid Airi artifact snapshot/);

    expect(mockArtifactCreate).not.toHaveBeenCalled();
    expect(mockArtifactVersionCreate).not.toHaveBeenCalled();
  });

  it("updates an artifact only when baseRevision matches", async () => {
    mockArtifactFindOne.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_flow",
          revision: 1,
          status: "draft",
          snapshot: { flowConfig },
          validation: { status: "valid", issues: [] },
        })
      )
    );
    mockArtifactFindOneAndUpdate.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_flow",
          revision: 2,
          status: "draft",
          snapshot: { flowConfig },
          validation: { status: "valid", issues: [] },
        })
      )
    );

    const artifact = await updateAiriArtifact({
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      userId: "user-1",
      baseRevision: 1,
      snapshot: { flowConfig },
      actor: { type: "user", id: "user-1" },
      changeSummary: "Edited Flow",
    });

    expect(mockArtifactFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "artifact-1",
        workspaceId: "workspace-1",
        revision: 1,
      }),
      expect.objectContaining({
        $inc: { revision: 1 },
      }),
      expect.objectContaining({ new: true })
    );
    expect(mockArtifactVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-1",
        revision: 2,
        changeSummary: "Edited Flow",
      })
    );
    expect(artifact.revision).toBe(2);
  });

  it("throws a conflict without writing a version when baseRevision is stale", async () => {
    mockArtifactFindOneAndUpdate.mockReturnValue(chain(null));
    mockArtifactFindOne.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_template",
          revision: 3,
          status: "draft",
          snapshot: { templateDraft },
          validation: { status: "valid", issues: [] },
        })
      )
    );

    await expect(
      updateAiriArtifact({
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        userId: "user-1",
        baseRevision: 1,
        snapshot: { templateDraft },
      })
    ).rejects.toBeInstanceOf(AiriArtifactConflictError);

    expect(mockArtifactVersionCreate).not.toHaveBeenCalled();
  });

  it("submits a template artifact through the unified template service", async () => {
    const supabase = { from: jest.fn() };
    mockArtifactFindOne.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_template",
          title: "airi_template",
          revision: 0,
          status: "draft",
          snapshot: { templateDraft },
          validation: { status: "valid", issues: [] },
        })
      )
    );
    mockCreateUnifiedTemplateRecord.mockResolvedValue({
      id: "template-row-1",
      metaTemplateId: "meta-template-1",
      metaTemplateStatus: "PENDING",
    });
    mockArtifactFindOneAndUpdate.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_template",
          title: "airi_template",
          revision: 0,
          status: "submitted",
          snapshot: { templateDraft },
          validation: { status: "valid", issues: [] },
          externalRefs: {
            unifiedTemplateId: "template-row-1",
            metaTemplateId: "meta-template-1",
          },
        })
      )
    );

    const result = await submitAiriArtifact({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      userId: "user-1",
    });

    expect(mockCreateUnifiedTemplateRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase,
        workspaceId: "workspace-1",
        userId: "user-1",
        name: "airi_template",
        channel: "whatsapp",
        whatsappData: expect.objectContaining({
          language: "en",
          category: "MARKETING",
        }),
      })
    );
    expect(result.result).toEqual(
      expect.objectContaining({
        kind: "whatsapp_template",
        unifiedTemplateId: "template-row-1",
        metaTemplateId: "meta-template-1",
      })
    );
  });

  it("resolves generated template header images before template submission", async () => {
    const generatedHeaderTemplateDraft = {
      ...templateDraft,
      components: [
        {
          type: "HEADER" as const,
          format: "IMAGE" as const,
          example: {
            header_handle: ["airi://creative-assets/64c13ab08edf48a008793cab"],
          },
        },
        ...templateDraft.components,
      ],
    };
    mockArtifactFindOne.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_template",
          title: "airi_template",
          revision: 0,
          status: "draft",
          snapshot: { templateDraft: generatedHeaderTemplateDraft },
          validation: { status: "valid", issues: [] },
        })
      )
    );
    mockCreativeAssetFindOne.mockReturnValue(
      selectChain({
        _id: "64c13ab08edf48a008793cab",
        workspaceId: "workspace-1",
        kind: "image",
        status: "complete",
        url: "gcs://creative-assets/workspaces/workspace-1/header.png",
        storageProvider: "gcs",
        bucket: "creative-assets",
        path: "workspaces/workspace-1/header.png",
      })
    );
    mockResolveCreativeAssetDisplayUrl.mockResolvedValue(
      "https://media.example/header.png"
    );
    mockCreateUnifiedTemplateRecord.mockResolvedValue({
      id: "template-row-1",
      metaTemplateId: "meta-template-1",
      metaTemplateStatus: "PENDING",
    });
    mockArtifactFindOneAndUpdate.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_template",
          title: "airi_template",
          revision: 0,
          status: "submitted",
          snapshot: { templateDraft: generatedHeaderTemplateDraft },
          validation: { status: "valid", issues: [] },
        })
      )
    );

    await submitAiriArtifact({
      supabase: { from: jest.fn() } as never,
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      userId: "user-1",
    });

    expect(mockCreativeAssetFindOne).toHaveBeenCalledWith({
      _id: "64c13ab08edf48a008793cab",
      workspaceId: "workspace-1",
      kind: "image",
    });
    expect(mockCreateUnifiedTemplateRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        whatsappData: expect.objectContaining({
          components: expect.arrayContaining([
            expect.objectContaining({
              type: "HEADER",
              format: "IMAGE",
              example: {
                header_handle: ["https://media.example/header.png"],
              },
            }),
          ]),
        }),
      })
    );
  });

  it("blocks template submission until generated template header images complete", async () => {
    const generatedHeaderTemplateDraft = {
      ...templateDraft,
      components: [
        {
          type: "HEADER" as const,
          format: "IMAGE" as const,
          example: {
            header_handle: ["airi://creative-assets/64c13ab08edf48a008793cab"],
          },
        },
        ...templateDraft.components,
      ],
    };
    mockArtifactFindOne.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_template",
          title: "airi_template",
          revision: 0,
          status: "draft",
          snapshot: { templateDraft: generatedHeaderTemplateDraft },
          validation: { status: "valid", issues: [] },
        })
      )
    );
    mockCreativeAssetFindOne.mockReturnValue(
      selectChain({
        _id: "64c13ab08edf48a008793cab",
        workspaceId: "workspace-1",
        kind: "image",
        status: "in_progress",
      })
    );

    await expect(
      submitAiriArtifact({
        supabase: { from: jest.fn() } as never,
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        userId: "user-1",
      })
    ).rejects.toThrow("Generated template header image is still running");

    expect(mockCreateUnifiedTemplateRecord).not.toHaveBeenCalled();
  });

  it("hard-stops direct Flow artifact submission instead of running a duplicate release lifecycle", async () => {
    mockArtifactFindOne.mockReturnValue(
      chain(
        leanDoc({
          _id: "artifact-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          createdByUserId: "user-1",
          kind: "whatsapp_flow",
          title: "lead_generation",
          revision: 0,
          status: "draft",
          snapshot: { flowConfig },
          validation: { status: "valid", issues: [] },
        })
      )
    );
    await expect(
      submitAiriArtifact({
        supabase: { from: jest.fn() } as never,
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        userId: "user-1",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockCreateMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockArtifactFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
