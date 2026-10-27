import { NextResponse } from "next/server";
import { z } from "zod";

import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  inspectWhatsAppQrImage,
  WhatsAppQrImageInspectionError,
} from "@/lib/whatsapp/qr-entry-points/image-inspection.server";
import {
  normalizeWhatsAppQrImportUrl,
  WhatsAppQrImportLinkError,
} from "@/lib/whatsapp/qr-entry-points/import-link";

export const runtime = "nodejs";

const REQUEST_MAX_BYTES = 64 * 1_024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
const boundedId = z.string().trim().min(1).max(256);

const JsonInspectSchema = z
  .object({
    workspaceId: boundedId,
    sourceId: boundedId,
    url: z.string().min(1).max(2_048),
    displayPhoneNumber: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

function isMultipart(request: Request): boolean {
  const contentType = request.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("multipart/form-data");
}

class MultipartBodyTooLargeError extends Error {}

async function readBodyWithinLimit(
  request: Request,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new MultipartBodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function parseBoundedMultipartFormData(
  request: Request
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType) throw new TypeError("Multipart content type is required");
  const body = await readBodyWithinLimit(request, MAX_MULTIPART_BYTES);
  const boundedRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  return boundedRequest.formData();
}

async function readImageBytes(file: File): Promise<Uint8Array | null> {
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) return null;
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
  return new Uint8Array(buffer);
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (isMultipart(request)) {
      const url = new URL(request.url);
      const ownership = z
        .object({
          workspaceId: boundedId,
          sourceId: boundedId,
        })
        .safeParse({
          workspaceId: url.searchParams.get("workspaceId") ?? "",
          sourceId: url.searchParams.get("sourceId") ?? "",
        });
      if (!ownership.success) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }

      const contentLengthHeader = request.headers.get("content-length");
      const contentLength = contentLengthHeader
        ? Number(contentLengthHeader)
        : null;
      if (
        contentLength !== null &&
        (!Number.isSafeInteger(contentLength) || contentLength < 0)
      ) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      if (contentLength !== null && contentLength > MAX_MULTIPART_BYTES) {
        return NextResponse.json(
          { error: "Request body is too large" },
          { status: 413 }
        );
      }

      const access = await getWhatsAppWorkspaceContext(
        ownership.data.workspaceId,
        {
          requireManager: true,
          sourceId: ownership.data.sourceId,
          requirePhoneNumber: true,
          managerErrorMessage:
            "Only managers and admins can inspect WhatsApp QR imports",
        }
      );
      if (access.error) return access.error;
      if (access.context.sourceId !== ownership.data.sourceId) {
        return NextResponse.json(
          { error: "WhatsApp source binding changed" },
          { status: 409 }
        );
      }

      let formData: FormData;
      try {
        formData = await parseBoundedMultipartFormData(request);
      } catch (error) {
        if (error instanceof MultipartBodyTooLargeError) {
          return NextResponse.json(
            { error: "Request body is too large" },
            { status: 413 }
          );
        }
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }

      const image = formData.get("image");
      if (!(image instanceof File)) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }

      const displayPhoneNumber =
        access.context.credentials.displayPhoneNumber || "";
      if (!displayPhoneNumber) {
        return NextResponse.json(
          { error: "Display phone number is required" },
          { status: 400 }
        );
      }

      const bytes = await readImageBytes(image);
      if (!bytes) {
        return NextResponse.json({ error: "Invalid image" }, { status: 400 });
      }

      try {
        const inspection = await inspectWhatsAppQrImage({
          bytes,
          mimeType: image.type || "application/octet-stream",
          displayPhoneNumber,
        });
        return NextResponse.json({
          intent: inspection.intent,
          image: inspection.image,
        });
      } catch (error) {
        if (error instanceof WhatsAppQrImageInspectionError) {
          return NextResponse.json(
            { error: "Image inspection failed", code: error.code },
            { status: 400 }
          );
        }
        if (error instanceof WhatsAppQrImportLinkError) {
          return NextResponse.json(
            { error: "Unsupported WhatsApp QR link", code: error.code },
            { status: 400 }
          );
        }
        throw error;
      }
    }

    let body: unknown;
    try {
      body = await readJsonBodyWithinLimit(request, REQUEST_MAX_BYTES);
    } catch (error) {
      if (
        error instanceof InvalidJsonBodyError ||
        error instanceof JsonBodyTooLargeError
      ) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      throw error;
    }

    const parsed = JsonInspectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const access = await getWhatsAppWorkspaceContext(parsed.data.workspaceId, {
      requireManager: true,
      sourceId: parsed.data.sourceId,
      requirePhoneNumber: true,
      managerErrorMessage:
        "Only managers and admins can inspect WhatsApp QR imports",
    });
    if (access.error) return access.error;
    if (access.context.sourceId !== parsed.data.sourceId) {
      return NextResponse.json(
        { error: "WhatsApp source binding changed" },
        { status: 409 }
      );
    }

    const displayPhoneNumber =
      access.context.credentials.displayPhoneNumber || "";
    if (!displayPhoneNumber) {
      return NextResponse.json(
        { error: "Display phone number is required" },
        { status: 400 }
      );
    }

    try {
      const intent = normalizeWhatsAppQrImportUrl({
        url: parsed.data.url,
        displayPhoneNumber,
      });
      return NextResponse.json({ intent });
    } catch (error) {
      if (error instanceof WhatsAppQrImportLinkError) {
        return NextResponse.json(
          { error: "Unsupported WhatsApp QR link", code: error.code },
          { status: 400 }
        );
      }
      if (error instanceof TypeError) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      throw error;
    }
  } catch {
    return NextResponse.json(
      { error: "Failed to inspect WhatsApp QR import" },
      { status: 500 }
    );
  }
}
