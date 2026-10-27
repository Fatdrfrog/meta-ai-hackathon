import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { ScenarioGeneratedRecipientMessage } from "@/models/scenario-generated-recipient-message";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

type Params = Promise<{ workspaceId: string }>;

function parsePositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const { searchParams } = new URL(request.url);
  const scenarioId = searchParams.get("scenarioId")?.trim();
  const branchId = searchParams.get("branchId")?.trim();
  const nodeId = searchParams.get("nodeId")?.trim();
  const page = parsePositiveInt(searchParams.get("page"), 1, 10_000);
  const limit = parsePositiveInt(searchParams.get("limit"), 50, 100);

  if (!scenarioId) return requiredFieldResponse("scenarioId");

  await connectDB();
  const query: Record<string, unknown> = { workspaceId, scenarioId };
  if (branchId) query.branchId = branchId;
  if (nodeId) query.nodeId = nodeId;

  const [total, items] = await Promise.all([
    ScenarioGeneratedRecipientMessage.countDocuments(query),
    ScenarioGeneratedRecipientMessage.find(query)
      .sort({ recipientName: 1, recipient: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<Record<string, unknown>[]>(),
  ]);

  return NextResponse.json({
    total,
    page,
    limit,
    items: items.map(item => ({
      id: String(item._id),
      scenarioId: item.scenarioId,
      nodeId: item.nodeId,
      branchId: item.branchId,
      conversationId: item.conversationId || null,
      channel: item.channel,
      recipient: item.recipient,
      recipientName: item.recipientName || null,
      sourceId: item.sourceId || null,
      taxonomyCategory: item.taxonomyCategory || null,
      internalLabels: item.internalLabels || [],
      text: item.text,
      sendStatus: item.sendStatus,
      error: item.error || null,
    })),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => ({}))) as {
    scenarioId?: string;
    messageId?: string;
    text?: string;
  };
  const scenarioId = String(body.scenarioId || "").trim();
  const messageId = String(body.messageId || "").trim();
  const text = String(body.text || "").trim();

  if (!scenarioId || !Types.ObjectId.isValid(messageId) || !text) {
    return NextResponse.json(
      { error: "scenarioId, messageId, and text are required" },
      { status: 400 }
    );
  }

  await connectDB();
  const updated = await ScenarioGeneratedRecipientMessage.findOneAndUpdate(
    {
      _id: new Types.ObjectId(messageId),
      workspaceId,
      scenarioId,
      sendStatus: "draft",
    },
    {
      $set: {
        text,
        updatedBy: access.userId,
      },
    },
    { new: true }
  ).lean<Record<string, unknown> | null>();

  if (!updated) {
    const existing = await ScenarioGeneratedRecipientMessage.findOne({
      _id: new Types.ObjectId(messageId),
      workspaceId,
      scenarioId,
    }).lean<Record<string, unknown> | null>();
    if (existing) {
      return NextResponse.json(
        {
          error:
            "Message is already being prepared or dispatched and cannot be edited",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  return NextResponse.json({
    item: {
      id: String(updated._id),
      text: updated.text,
      sendStatus: updated.sendStatus,
    },
  });
}
