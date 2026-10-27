import {
  authenticateRequest,
  hasPermission,
  type ApiKeyData,
} from "@/lib/api-auth";

export type OtpWriteOperation = "request" | "verify";

export type OtpApiAuthSuccess = {
  workspaceId: string;
  apiKey: ApiKeyData;
};

export type OtpApiAuthResult =
  | OtpApiAuthSuccess
  | {
      error: Response;
    };

function getPermissionError(operation: OtpWriteOperation): string {
  return operation === "verify"
    ? "API key does not have permission to verify OTPs"
    : "API key does not have permission to request OTPs";
}

export async function authenticateOtpWriteRequest(
  request: Request,
  operation: OtpWriteOperation
): Promise<OtpApiAuthResult> {
  const { apiKey, error } = await authenticateRequest(request);
  if (error) return { error };

  if (!apiKey || !hasPermission(apiKey, "write")) {
    return {
      error: Response.json(
        {
          success: false,
          error: getPermissionError(operation),
        },
        { status: 403 }
      ),
    };
  }

  return {
    workspaceId: apiKey.workspace_id,
    apiKey,
  };
}
