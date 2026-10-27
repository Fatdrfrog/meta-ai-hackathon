jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import {
  getWorkspaceTaxonomy,
  getWorkspaceTaxonomyStrict,
} from "@/lib/classifier/taxonomy-server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const mockFrom = supabaseAdmin.from as jest.Mock;
const mockMaybeSingle = jest.fn();
const mockLimit = jest.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockOrder = jest.fn(() => ({ limit: mockLimit }));
const mockEq = jest.fn(() => ({ order: mockOrder }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));

function taxonomyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "taxonomy-1",
    workspace_id: "workspace-1",
    vertical: "support",
    labels: ["Billing", "Other"],
    guidelines: "Prefer the customer's primary intent.",
    few_shots: [{ text: "Need an invoice", label: "Billing" }],
    confidence_threshold: 0.8,
    version: "v3",
    ...overrides,
  };
}

describe("workspace taxonomy server", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockReturnValue({ select: mockSelect });
  });

  it("keeps the existing fail-soft reader for unrelated callers", async () => {
    mockMaybeSingle.mockResolvedValue({ data: taxonomyRow(), error: null });

    await expect(getWorkspaceTaxonomy("workspace-1")).resolves.toMatchObject({
      id: "taxonomy-1",
      workspaceId: "workspace-1",
      labels: ["Billing", "Other"],
      confidenceThreshold: 0.8,
      version: "v3",
    });
    expect(mockFrom).toHaveBeenCalledWith("taxonomies");
    expect(mockEq).toHaveBeenCalledWith("workspace_id", "workspace-1");
  });

  it("keeps fail-soft behavior on a taxonomy query error", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "transport failed" },
    });

    await expect(getWorkspaceTaxonomy("workspace-1")).resolves.toMatchObject({
      id: "default",
      workspaceId: "workspace-1",
    });
  });

  it("fails the strict reader on a query error", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "transport failed" },
    });

    await expect(
      getWorkspaceTaxonomyStrict("workspace-1")
    ).rejects.toMatchObject({ code: "taxonomy_read_failed", retryable: true });
  });

  it("uses a normalized default only for a successful no-row read", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const resolved = await getWorkspaceTaxonomyStrict("workspace-1");

    expect(resolved.taxonomy).toMatchObject({
      id: "default",
      workspaceId: "workspace-1",
    });
    expect(resolved.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns a stable digest for the same normalized semantic taxonomy", async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: taxonomyRow(), error: null })
      .mockResolvedValueOnce({ data: taxonomyRow(), error: null });

    const first = await getWorkspaceTaxonomyStrict("workspace-1");
    const second = await getWorkspaceTaxonomyStrict("workspace-1");

    expect(first.digest).toBe(second.digest);
    expect(first.taxonomy.version).toBe("v3");
  });

  it("excludes non-semantic vertical metadata from the digest", async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: taxonomyRow(), error: null })
      .mockResolvedValueOnce({
        data: taxonomyRow({ vertical: "retail" }),
        error: null,
      });

    const baseline = await getWorkspaceTaxonomyStrict("workspace-1");
    const metadataChanged = await getWorkspaceTaxonomyStrict("workspace-1");

    expect(metadataChanged.taxonomy.vertical).toBe("retail");
    expect(metadataChanged.digest).toBe(baseline.digest);
  });

  it.each([
    ["label order", { labels: ["Other", "Billing"] }],
    [
      "few-shot order",
      {
        few_shots: [
          { text: "Second", label: "Billing" },
          { text: "Need an invoice", label: "Billing" },
        ],
      },
    ],
    ["taxonomy version", { version: "v4" }],
    ["guidelines", { guidelines: "Use lifecycle state first." }],
    ["confidence threshold", { confidence_threshold: 0.9 }],
  ])("changes the digest when semantic %s changes", async (_name, override) => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: taxonomyRow(), error: null })
      .mockResolvedValueOnce({
        data: taxonomyRow(override as Record<string, unknown>),
        error: null,
      });

    const baseline = await getWorkspaceTaxonomyStrict("workspace-1");
    const changed = await getWorkspaceTaxonomyStrict("workspace-1");

    expect(changed.digest).not.toBe(baseline.digest);
  });
});
