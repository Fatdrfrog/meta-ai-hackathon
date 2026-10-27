import { createClient as createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { OutboundAttachment } from "@/types/outbound-attachment";

type ReplyUploadResponse = {
  attachment?: OutboundAttachment;
  error?: string;
  // Direct uploads also receive a signed storage target.
  upload?: {
    bucket: string;
    path: string;
    token: string;
  };
};

async function readUploadResponse(
  response: Response
): Promise<ReplyUploadResponse | null> {
  const text = await response.text().catch(() => "");
  if (!text) return null;

  try {
    return JSON.parse(text) as ReplyUploadResponse;
  } catch {
    return { error: text };
  }
}

function getAttachmentUploadErrorMessage(
  file: File,
  response: Response,
  providerMessage: string | undefined
): string {
  const fileName = file.name || "attachment";

  if (providerMessage) {
    return `${fileName}: ${providerMessage}`;
  }

  if (response.status === 413) {
    return `${fileName}: upload request is too large for the current upload endpoint (HTTP 413).`;
  }

  return `${fileName}: upload failed with HTTP ${response.status}`;
}

export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;

export class AttachmentUploadTimeoutError extends Error {
  constructor(file: File) {
    super(`${file.name || "attachment"}: upload timed out. Try again.`);
    this.name = "AttachmentUploadTimeoutError";
  }
}

// Carries the route's HTTP status and reason so the failure event records a
// cause instead of collapsing everything into one opaque message string.
export class AttachmentUploadError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(params: { message: string; status: number; reason?: string }) {
    super(params.message);
    this.name = "AttachmentUploadError";
    this.status = params.status;
    this.reason = params.reason;
  }
}

function toUploadRouteError(
  file: File,
  response: Response,
  payload: ReplyUploadResponse | null
): AttachmentUploadError {
  const reason = payload?.error?.trim() || undefined;
  return new AttachmentUploadError({
    message: getAttachmentUploadErrorMessage(file, response, reason),
    status: response.status,
    reason,
  });
}

// Groups a partly-failed batch and keeps the source File objects so the
// composer can retry the exact files that failed without re-picking them.
export class AttachmentUploadBatchError extends Error {
  readonly failedFiles: File[];

  constructor(message: string, failedFiles: File[]) {
    super(message);
    this.name = "AttachmentUploadBatchError";
    this.failedFiles = failedFiles;
  }
}

// A stuck upload used to freeze the whole reply composer, because the busy flag
// was cleared only after the request settled. The signal cancels requests that
// respect it, and the race guarantees the promise settles even when a step
// ignores the signal (for example the Supabase storage upload).
async function runUploadWithTimeout<T>(
  file: File,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AttachmentUploadTimeoutError(file));
    }, ATTACHMENT_UPLOAD_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AttachmentUploadTimeoutError(file);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function uploadAttachmentThroughApi(
  conversationId: string,
  file: File
): Promise<OutboundAttachment> {
  return runUploadWithTimeout(file, async signal => {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(
      `/api/conversations/${conversationId}/reply/upload`,
      {
        method: "POST",
        body: formData,
        signal,
      }
    );

    const payload = await readUploadResponse(res);
    if (!res.ok || !payload?.attachment) {
      throw toUploadRouteError(file, res, payload);
    }

    return payload.attachment;
  });
}

export async function uploadAttachmentDirectly(
  conversationId: string,
  file: File
): Promise<OutboundAttachment> {
  return runUploadWithTimeout(file, async signal => {
    const res = await fetch(
      `/api/conversations/${conversationId}/reply/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "direct",
          fileName: file.name || "attachment",
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
        }),
        signal,
      }
    );

    const payload = await readUploadResponse(res);
    if (!res.ok || !payload?.attachment || !payload.upload) {
      throw toUploadRouteError(file, res, payload);
    }

    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.storage
      .from(payload.upload.bucket)
      .uploadToSignedUrl(payload.upload.path, payload.upload.token, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (error) {
      // Storage upload failures carry no HTTP status; 0 marks the client-side
      // step so the cause breakdown can tell them apart from route rejections.
      throw new AttachmentUploadError({
        message: `${file.name || "attachment"}: ${error.message}`,
        status: 0,
        reason: error.message,
      });
    }

    return payload.attachment;
  });
}
