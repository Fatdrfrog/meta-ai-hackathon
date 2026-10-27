import { PATCH } from "./route";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import LlmEvaluationRegressionCase from "@/models/llm-evaluation-regression-case";
import LlmEvaluationReviewItem from "@/models/llm-evaluation-review-item";

jest.mock("@/lib/mongoose", () => jest.fn(async () => undefined));
jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: jest.fn(),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));
jest.mock("@/models/llm-evaluation-regression-case", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
  },
}));
jest.mock("@/models/llm-evaluation-review-item", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

const reviewItemId = "65f1f2f3f4f5f6f7f8f9fa01";

function patchRequest(body: unknown) {
  return new Request(
    `http://localhost/api/ai-quality/review-items/${reviewItemId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function leanResult<T>(value: T) {
  return {
    lean: jest.fn(async () => value),
  };
}

describe("AI quality review item PATCH", () => {
  beforeEach(() => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: jest.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
    });
    (checkUserWorkspaceAccess as jest.Mock).mockResolvedValue(true);
    (LlmEvaluationReviewItem.findOne as jest.Mock).mockReturnValue(
      leanResult(null)
    );
    (LlmEvaluationReviewItem.findOneAndUpdate as jest.Mock).mockReturnValue(
      leanResult(null)
    );
    (LlmEvaluationRegressionCase.create as jest.Mock).mockResolvedValue({
      _id: "case-1",
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("rejects invalid request body types with a 400", async () => {
    const response = await PATCH(
      patchRequest({ workspaceId: 42, action: "resolve" }) as never,
      { params: Promise.resolve({ id: reviewItemId }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request body",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("requires an input excerpt before creating a regression case", async () => {
    (LlmEvaluationReviewItem.findOne as jest.Mock).mockReturnValue(
      leanResult({
        _id: reviewItemId,
        workspaceId: "workspace-1",
        status: "open",
        issueType: "knowledge_gap",
        severity: "high",
        title: "Missing answer",
        inputExcerpt: null,
      })
    );

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        action: "resolve",
        createRegressionCase: true,
      }) as never,
      { params: Promise.resolve({ id: reviewItemId }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "inputExcerpt is required to create a regression case",
    });
    expect(LlmEvaluationReviewItem.findOneAndUpdate).not.toHaveBeenCalled();
    expect(LlmEvaluationRegressionCase.create).not.toHaveBeenCalled();
  });

  it("stores a resolved human evaluation without creating a regression case", async () => {
    const existing = {
      _id: reviewItemId,
      workspaceId: "workspace-1",
      status: "open",
      issueType: "bad_retrieval",
      severity: "medium",
      title: "Weak retrieval",
      inputExcerpt: "Where is my order?",
    };
    const updated = {
      ...existing,
      status: "resolved",
      conversationId: "conversation-1",
      messageId: "message-1",
      traceId: "trace-1",
      source: "customer_feedback",
    };
    (LlmEvaluationReviewItem.findOne as jest.Mock).mockReturnValue(
      leanResult(existing)
    );
    (LlmEvaluationReviewItem.findOneAndUpdate as jest.Mock).mockReturnValue(
      leanResult(updated)
    );

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        action: "resolve",
        datasetDecision: "candidate",
        overallScore: 0.8,
      }) as never,
      { params: Promise.resolve({ id: reviewItemId }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      item: { id: reviewItemId, status: "resolved" },
      regressionCaseId: null,
    });
    expect(LlmEvaluationReviewItem.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: reviewItemId, workspaceId: "workspace-1" },
      {
        $set: {
          status: "resolved",
          resolvedByUserId: "user-1",
          resolvedAt: expect.any(Date),
          ignoredReason: null,
          humanEvaluation: {
            relevanceScore: null,
            trustworthinessScore: null,
            concisenessScore: null,
            completenessScore: null,
            safetyScore: null,
            overallScore: 0.8,
            judgeExplanation: null,
            datasetDecision: "candidate",
            datasetSplit: "validation",
          },
        },
      },
      { new: true }
    );
    expect(LlmEvaluationRegressionCase.create).not.toHaveBeenCalled();
  });
});
