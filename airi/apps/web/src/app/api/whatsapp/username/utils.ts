import { handlePhoneNumberUsernameUpdate } from "@/lib/whatsapp/phone/number-username";
import { compactWhatsAppString } from "@icecore/shared/lib/whatsapp/value-utils";
import {
  getWhatsAppGraphClient,
  MetaGraphRequestError,
} from "@icecore/shared/lib/meta/api";
import { readBusinessUsernameState } from "@icecore/whatsapp/businessUsernameState";

const graphClient = getWhatsAppGraphClient();

type WhatsAppBusinessUsernameStatus =
  | "approved"
  | "reserved"
  | "deleted"
  | (string & {});

type WhatsAppBusinessUsernameTransferAction = "none" | "force_transfer";

type WhatsAppBusinessUsernameState = {
  username?: string;
  status?: WhatsAppBusinessUsernameStatus;
};

type GraphUsernameMutationResponse = {
  status?: string;
};

type GraphUsernameSuggestionsResponse = {
  data?: Array<{
    username_suggestions?: string[];
  }>;
};

export class WhatsAppBusinessUsernameError extends Error {
  code?: number | string;
  status: number;
  transferRequired: boolean;

  constructor(params: {
    code?: number | string;
    message: string;
    status: number;
    transferRequired?: boolean;
  }) {
    super(params.message);
    this.name = "WhatsAppBusinessUsernameError";
    this.code = params.code;
    this.status = params.status;
    this.transferRequired = params.transferRequired === true;
  }
}

const USERNAME_ERROR_MESSAGES: Record<number, string> = {
  10: "The WhatsApp token cannot manage usernames for this phone number.",
  33: "Meta cannot access this WhatsApp phone number. Reconnect WhatsApp or check phone-number access.",
  100: "This username format is invalid.",
  147001: "This username is not available. Try another one.",
  147002:
    "This WhatsApp Business Account is not eligible to request a username yet.",
  147003:
    "Link this phone number to the Facebook Page that already uses this username, then retry.",
  147004:
    "Link this phone number to the Instagram account that already uses this username, then retry.",
  147005:
    "This username belongs to another phone number in the same business. Select transfer to move it here.",
  147006:
    "Username API is not available for this WhatsApp Business app number. Manage the username in the WhatsApp Business app.",
  133010:
    "Register this WhatsApp phone number for Cloud API before claiming a username.",
};

function normalizeMetaUsernameError(error: unknown, fallback: string): never {
  if (error instanceof MetaGraphRequestError) {
    const code = error.metaError?.code;
    const mappedMessage =
      typeof code === "number" ? USERNAME_ERROR_MESSAGES[code] : undefined;
    const message =
      mappedMessage ||
      error.formattedError?.message ||
      error.metaError?.error_user_msg ||
      error.metaError?.message ||
      fallback;

    throw new WhatsAppBusinessUsernameError({
      code,
      message,
      status: code === 147005 ? 409 : error.status || 500,
      transferRequired: code === 147005,
    });
  }

  if (error instanceof Error) {
    throw new WhatsAppBusinessUsernameError({
      message: error.message || fallback,
      status: 500,
    });
  }

  throw new WhatsAppBusinessUsernameError({
    message: fallback,
    status: 500,
  });
}

export function normalizeBusinessUsernameInput(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().replace(/^@+/, "").trim();
}

export function normalizeBusinessUsernameTransferAction(
  input: unknown
): WhatsAppBusinessUsernameTransferAction {
  return input === "force_transfer" ? "force_transfer" : "none";
}

export function readStoredWhatsAppBusinessUsernameState(
  credentials: unknown
): WhatsAppBusinessUsernameState {
  const record =
    credentials &&
    typeof credentials === "object" &&
    !Array.isArray(credentials)
      ? (credentials as Record<string, unknown>)
      : {};
  const state = readBusinessUsernameState(record.business_username);
  if (!state) return {};
  return {
    username: state.username,
    status: state.status,
  };
}

export function hasStoredWhatsAppBusinessUsername(
  state: WhatsAppBusinessUsernameState
): boolean {
  return Boolean(state.username && state.status !== "deleted");
}

export function getWhatsAppBusinessUsernameApiUnavailableReason(input: {
  coexistenceMode?: boolean;
  isOnBizApp?: boolean;
}): string | null {
  if (input.coexistenceMode === true || input.isOnBizApp === true) {
    return "Username API is not available for this WhatsApp Business app number. Manage the username in the WhatsApp Business app.";
  }

  return null;
}

export async function listWhatsAppBusinessUsernameSuggestions(params: {
  accessToken: string;
  phoneNumberId: string;
}): Promise<string[]> {
  try {
    const response =
      await graphClient.getJson<GraphUsernameSuggestionsResponse>(
        `${params.phoneNumberId}/username_suggestions`,
        { token: params.accessToken }
      );
    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const item of response.data || []) {
      for (const suggestion of item.username_suggestions || []) {
        const normalized = normalizeBusinessUsernameInput(suggestion);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        suggestions.push(normalized);
      }
    }
    return suggestions;
  } catch (error) {
    normalizeMetaUsernameError(
      error,
      "Failed to load WhatsApp username suggestions."
    );
  }
}

export async function adoptWhatsAppBusinessUsername(params: {
  accessToken: string;
  phoneNumberId: string;
  transferAction?: WhatsAppBusinessUsernameTransferAction;
  username: string;
}): Promise<WhatsAppBusinessUsernameState> {
  const username = normalizeBusinessUsernameInput(params.username);
  if (!username) {
    throw new WhatsAppBusinessUsernameError({
      message: "Username is required.",
      status: 400,
    });
  }

  try {
    const response = await graphClient.postJson<GraphUsernameMutationResponse>(
      `${params.phoneNumberId}/username`,
      {
        token: params.accessToken,
        body: {
          username,
          transfer_action: params.transferAction || "none",
        },
      }
    );
    const status = compactWhatsAppString(response.status) || "reserved";
    await handlePhoneNumberUsernameUpdate({
      value: {
        phone_number_id: params.phoneNumberId,
        status,
        username,
      },
    });
    return { username, status };
  } catch (error) {
    normalizeMetaUsernameError(
      error,
      "Failed to create WhatsApp business username."
    );
  }
}
