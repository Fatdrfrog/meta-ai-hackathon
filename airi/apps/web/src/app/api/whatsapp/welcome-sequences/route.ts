import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  createWelcomeMessageSequence,
  deleteWelcomeMessageSequence,
  getWelcomeMessageSequence,
  listWelcomeMessageSequences,
  updateWelcomeMessageSequence,
  WelcomeSequenceRequestError,
} from "@/lib/whatsapp/welcome-sequence-service";
import { NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

function hasWelcomeSequenceCredentials(credentials: {
  accessToken?: string;
  wabaId?: string;
  businessId?: string;
}) {
  return Boolean(
    credentials.accessToken && (credentials.wabaId || credentials.businessId)
  );
}

function connectionRequiredResponse() {
  return NextResponse.json(
    {
      error: "Connect WhatsApp before managing welcome message sequences.",
      requiresWhatsAppConnection: true,
      sequences: [],
    },
    { status: 409 }
  );
}

function errorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status =
    error instanceof WelcomeSequenceRequestError ? error.status : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const sequenceId = searchParams.get("sequenceId");
    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : undefined;
    const limit =
      typeof parsedLimit === "number" &&
      Number.isFinite(parsedLimit) &&
      parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), 500)
        : undefined;

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: false,
    });
    if (accessResult.error) return accessResult.error;
    if (!hasWelcomeSequenceCredentials(accessResult.context.credentials)) {
      return connectionRequiredResponse();
    }

    const result = sequenceId
      ? await getWelcomeMessageSequence(workspaceId, sequenceId)
      : await listWelcomeMessageSequences(workspaceId, { limit });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "Failed to load welcome message sequences");
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { workspaceId, name, text, autofillMessageContent, iceBreakers } =
      body || {};
    if (!workspaceId || !name) {
      return NextResponse.json(
        { error: "workspaceId and name are required" },
        { status: 400 }
      );
    }

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      managerErrorMessage:
        "Only managers and admins can create welcome message sequences",
      requireCredentials: false,
      requireManager: true,
    });
    if (accessResult.error) return accessResult.error;
    if (!hasWelcomeSequenceCredentials(accessResult.context.credentials)) {
      return connectionRequiredResponse();
    }

    const sequence = await createWelcomeMessageSequence(workspaceId, {
      name,
      text,
      autofillMessageContent,
      iceBreakers,
    });
    return NextResponse.json({ sequence });
  } catch (error) {
    return errorResponse(error, "Failed to create welcome message sequence");
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const {
      workspaceId,
      sequenceId,
      name,
      text,
      autofillMessageContent,
      iceBreakers,
    } = body || {};
    if (!workspaceId || !sequenceId) {
      return NextResponse.json(
        { error: "workspaceId and sequenceId are required" },
        { status: 400 }
      );
    }

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      managerErrorMessage:
        "Only managers and admins can update welcome message sequences",
      requireCredentials: false,
      requireManager: true,
    });
    if (accessResult.error) return accessResult.error;
    if (!hasWelcomeSequenceCredentials(accessResult.context.credentials)) {
      return connectionRequiredResponse();
    }

    const sequence = await updateWelcomeMessageSequence(workspaceId, {
      sequenceId,
      name,
      text,
      autofillMessageContent,
      iceBreakers,
    });
    return NextResponse.json({ sequence });
  } catch (error) {
    return errorResponse(error, "Failed to update welcome message sequence");
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const sequenceId = searchParams.get("sequenceId");
    if (!workspaceId || !sequenceId) {
      return NextResponse.json(
        { error: "workspaceId and sequenceId are required" },
        { status: 400 }
      );
    }

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      managerErrorMessage:
        "Only managers and admins can delete welcome message sequences",
      requireCredentials: false,
      requireManager: true,
    });
    if (accessResult.error) return accessResult.error;
    if (!hasWelcomeSequenceCredentials(accessResult.context.credentials)) {
      return connectionRequiredResponse();
    }

    return NextResponse.json(
      await deleteWelcomeMessageSequence(workspaceId, sequenceId)
    );
  } catch (error) {
    return errorResponse(error, "Failed to delete welcome message sequence");
  }
}
