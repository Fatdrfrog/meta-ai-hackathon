import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { NextResponse } from "next/server";
import {
  adoptWhatsAppBusinessUsername,
  getWhatsAppBusinessUsernameApiUnavailableReason,
  hasStoredWhatsAppBusinessUsername,
  listWhatsAppBusinessUsernameSuggestions,
  normalizeBusinessUsernameInput,
  normalizeBusinessUsernameTransferAction,
  readStoredWhatsAppBusinessUsernameState,
  WhatsAppBusinessUsernameError,
} from "./utils";
import { requiredFieldResponse } from "@/lib/api/json-body";

function missingConnectionResponse() {
  return NextResponse.json({
    canCreate: false,
    connected: false,
    hasUsername: false,
    suggestions: [],
  });
}

function usernameErrorResponse(error: unknown, fallback: string) {
  if (error instanceof WhatsAppBusinessUsernameError) {
    return NextResponse.json(
      {
        code: error.code,
        error: error.message,
        transferRequired: error.transferRequired,
      },
      { status: error.status }
    );
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 }
  );
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const includeSuggestions = searchParams.get("includeSuggestions") === "1";

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: false,
    });
    if (accessResult.error) return accessResult.error;

    const { accessToken, credentials, phoneNumberId } = accessResult.context;
    if (!accessToken || !phoneNumberId) {
      return missingConnectionResponse();
    }

    const current = readStoredWhatsAppBusinessUsernameState(
      accessResult.context.rawCredentials
    );
    const hasUsername = hasStoredWhatsAppBusinessUsername(current);
    const unavailableReason =
      getWhatsAppBusinessUsernameApiUnavailableReason(credentials);
    const canCreate = !hasUsername && !unavailableReason;
    let suggestions: string[] = [];
    if (canCreate && includeSuggestions) {
      try {
        suggestions = await listWhatsAppBusinessUsernameSuggestions({
          accessToken,
          phoneNumberId,
        });
      } catch {
        suggestions = [];
      }
    }

    return NextResponse.json({
      canCreate,
      connected: true,
      hasUsername,
      status: current.status,
      suggestions,
      usernameApiUnavailableReason: unavailableReason,
      username: current.username,
    });
  } catch (error) {
    return usernameErrorResponse(
      error,
      "Failed to load WhatsApp business username."
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const workspaceId =
      typeof body?.workspaceId === "string" ? body.workspaceId : "";
    const username = normalizeBusinessUsernameInput(body?.username);
    const transferAction = normalizeBusinessUsernameTransferAction(
      body?.transferAction
    );

    if (!workspaceId || !username) {
      return NextResponse.json(
        { error: "workspaceId and username are required" },
        { status: 400 }
      );
    }

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      managerErrorMessage:
        "Only managers and admins can create a WhatsApp business username",
      requireCredentials: false,
      requireManager: true,
    });
    if (accessResult.error) return accessResult.error;

    const { accessToken, credentials, phoneNumberId } = accessResult.context;
    if (!accessToken || !phoneNumberId) {
      return NextResponse.json(
        {
          error: "Connect WhatsApp before creating a business username.",
          requiresWhatsAppConnection: true,
        },
        { status: 409 }
      );
    }

    const current = readStoredWhatsAppBusinessUsernameState(
      accessResult.context.rawCredentials
    );
    if (hasStoredWhatsAppBusinessUsername(current)) {
      return NextResponse.json({
        hasUsername: true,
        status: current.status,
        username: current.username,
      });
    }

    const unavailableReason =
      getWhatsAppBusinessUsernameApiUnavailableReason(credentials);
    if (unavailableReason) {
      return NextResponse.json(
        {
          code: 147006,
          error: unavailableReason,
          usernameApiUnavailable: true,
        },
        { status: 409 }
      );
    }

    const result = await adoptWhatsAppBusinessUsername({
      accessToken,
      phoneNumberId,
      transferAction,
      username,
    });

    return NextResponse.json({
      hasUsername: true,
      status: result.status,
      username: result.username,
    });
  } catch (error) {
    return usernameErrorResponse(
      error,
      "Failed to create WhatsApp business username."
    );
  }
}
