import { WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH } from "@icecore/scenario-contracts";
import { getMetaGraphRateLimitMetadata } from "@icecore/shared/lib/meta/api";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import {
  acquireWhatsAppMetaReadLock,
  buildWhatsAppMetaRateLimitCredentialPatch,
  META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD,
  releaseWhatsAppMetaReadPermit,
  setCachedWhatsAppMetaReadCooldownUntil,
} from "@/lib/whatsapp/meta-read-policy";
import {
  applyWhatsAppQrMessage,
  checkWhatsAppQrProviderState,
  connectWhatsAppQrEntryPointCode,
  createWhatsAppQrEntryPointCode,
  deleteWhatsAppQrCodeFromProvider,
  getWhatsAppQrEntryPointDetail,
  parseWhatsAppQrIdempotencyKey,
  reconcileWhatsAppQrOperation,
  replaceWhatsAppQrCode,
  setWhatsAppQrCodeRouting,
  WhatsAppQrServiceError,
  whatsAppQrCommandResultResponse,
  whatsAppQrServiceErrorResponse,
} from "@/lib/whatsapp/qr-entry-points/http";
import {
  asRecord,
  readNonEmptyStringField,
} from "@icecore/shared/lib/value-utils";

export const runtime = "nodejs";

const REQUEST_MAX_BYTES = 64 * 1_024;
const boundedId = z.string().trim().min(1).max(256);
const version = z.number().int().nonnegative();
const desiredMessage = z
  .string()
  .min(1)
  .max(WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH)
  .refine(value => value.trim() === value && value.trim().length > 0);

function providerRateLimitEvidence(error: unknown): unknown | null {
  if (!(error instanceof WhatsAppQrServiceError)) return null;
  const evidence = error.providerEvidence;
  if (!evidence) return null;
  const candidate = {
    ...(evidence.httpStatus !== undefined
      ? { status: evidence.httpStatus }
      : {}),
    ...(evidence.providerCode !== undefined
      ? { metaError: { code: evidence.providerCode } }
      : {}),
  };
  return getMetaGraphRateLimitMetadata(candidate) ? candidate : null;
}

const CommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("create"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      desiredMessage,
      expectedEntryPointVersion: version,
    })
    .strict(),
  z
    .object({
      command: z.literal("connect"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      providerCode: boundedId,
      desiredMessage,
      expectedEntryPointVersion: version,
    })
    .strict(),
  z
    .object({
      command: z.literal("apply_message"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      desiredMessage,
      expectedEntryPointVersion: version,
      expectedCodeVersion: version,
    })
    .strict(),
  z
    .object({
      command: z.literal("replace"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      desiredMessage,
      expectedEntryPointVersion: version,
      expectedCodeVersion: version,
    })
    .strict(),
  z
    .object({
      command: z.literal("set_routing"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      codeId: boundedId,
      routingState: z.enum(["ENABLED", "DISABLED"]),
      expectedEntryPointVersion: version,
      expectedCodeVersion: version,
    })
    .strict(),
  z
    .object({
      command: z.literal("delete"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      codeId: boundedId,
      confirmed: z.literal(true),
      expectedEntryPointVersion: version,
      expectedCodeVersion: version,
    })
    .strict(),
  z
    .object({
      command: z.literal("check_provider"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      expectedEntryPointVersion: version,
      expectedCodeVersion: version,
    })
    .strict(),
  z
    .object({
      command: z.literal("reconcile"),
      workspaceId: boundedId,
      sourceId: boundedId,
      entryPointId: boundedId,
      operationId: boundedId,
    })
    .strict(),
]);

export async function POST(request: Request): Promise<Response> {
  try {
    const idempotencyKey = parseWhatsAppQrIdempotencyKey(request);
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "Idempotency-Key is required", code: "INVALID_INPUT" },
        { status: 400 }
      );
    }

    let body: unknown;
    try {
      body = await readJsonBodyWithinLimit(request, REQUEST_MAX_BYTES);
    } catch (error) {
      if (
        error instanceof InvalidJsonBodyError ||
        error instanceof JsonBodyTooLargeError
      ) {
        return NextResponse.json(
          { error: "Invalid request", code: "INVALID_INPUT" },
          { status: 400 }
        );
      }
      throw error;
    }

    const parsed = CommandSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", code: "INVALID_INPUT" },
        { status: 400 }
      );
    }

    const command = parsed.data;
    const access = await getWhatsAppWorkspaceContext(command.workspaceId, {
      requireManager: true,
      sourceId: command.sourceId,
      requirePhoneNumber: true,
      managerErrorMessage:
        "Only managers and admins can mutate WhatsApp QR entry points",
    });
    if (access.error) return access.error;
    if (
      access.context.sourceId !== command.sourceId ||
      !access.context.accessToken ||
      !access.context.wabaId ||
      !access.context.phoneNumberId
    ) {
      return NextResponse.json(
        {
          error: "WhatsApp source binding changed",
          code: "OPERATION_CONFLICT",
        },
        { status: 409 }
      );
    }

    const accessToken = access.context.accessToken;
    const wabaId = access.context.wabaId;
    const phoneNumberId = access.context.phoneNumberId;
    const rawCredentials = asRecord(access.context.rawCredentials);

    const detail = await getWhatsAppQrEntryPointDetail({
      workspaceId: command.workspaceId,
      entryPointId: command.entryPointId,
    });
    if (!detail) {
      return NextResponse.json(
        { error: "Entry point not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }
    const binding = detail.entryPoint;
    if (
      (binding.sourceId && binding.sourceId !== command.sourceId) ||
      (binding.wabaId && binding.wabaId !== wabaId) ||
      (binding.phoneNumberId && binding.phoneNumberId !== phoneNumberId)
    ) {
      return NextResponse.json(
        {
          error: "WhatsApp source binding changed",
          code: "OPERATION_CONFLICT",
        },
        { status: 409 }
      );
    }

    try {
      switch (command.command) {
        case "create": {
          const result = await createWhatsAppQrEntryPointCode({
            workspaceId: command.workspaceId,
            entryPointId: command.entryPointId,
            sourceId: command.sourceId,
            desiredMessage: command.desiredMessage,
            expectedEntryPointVersion: command.expectedEntryPointVersion,
            idempotencyKey,
            accessToken,
            wabaId,
            phoneNumberId,
          });
          return whatsAppQrCommandResultResponse(result);
        }
        case "connect": {
          const result = await connectWhatsAppQrEntryPointCode({
            workspaceId: command.workspaceId,
            entryPointId: command.entryPointId,
            sourceId: command.sourceId,
            providerCode: command.providerCode,
            desiredMessage: command.desiredMessage,
            expectedEntryPointVersion: command.expectedEntryPointVersion,
            idempotencyKey,
            accessToken,
            wabaId,
            phoneNumberId,
          });
          return whatsAppQrCommandResultResponse(result);
        }
        case "apply_message": {
          const result = await applyWhatsAppQrMessage({
            workspaceId: command.workspaceId,
            entryPointId: command.entryPointId,
            sourceId: command.sourceId,
            desiredMessage: command.desiredMessage,
            expectedEntryPointVersion: command.expectedEntryPointVersion,
            expectedCodeVersion: command.expectedCodeVersion,
            idempotencyKey,
            accessToken,
          });
          return whatsAppQrCommandResultResponse(result);
        }
        case "replace": {
          const result = await replaceWhatsAppQrCode({
            workspaceId: command.workspaceId,
            entryPointId: command.entryPointId,
            sourceId: command.sourceId,
            desiredMessage: command.desiredMessage,
            expectedEntryPointVersion: command.expectedEntryPointVersion,
            expectedCodeVersion: command.expectedCodeVersion,
            idempotencyKey,
            accessToken,
          });
          return whatsAppQrCommandResultResponse(result);
        }
        case "set_routing": {
          const result = await setWhatsAppQrCodeRouting({
            workspaceId: command.workspaceId,
            entryPointId: command.entryPointId,
            sourceId: command.sourceId,
            codeId: command.codeId,
            routingState: command.routingState,
            expectedEntryPointVersion: command.expectedEntryPointVersion,
            expectedCodeVersion: command.expectedCodeVersion,
            idempotencyKey,
          });
          return whatsAppQrCommandResultResponse(result);
        }
        case "delete": {
          const result = await deleteWhatsAppQrCodeFromProvider({
            workspaceId: command.workspaceId,
            entryPointId: command.entryPointId,
            sourceId: command.sourceId,
            phoneNumberId,
            codeId: command.codeId,
            confirmed: command.confirmed,
            expectedEntryPointVersion: command.expectedEntryPointVersion,
            expectedCodeVersion: command.expectedCodeVersion,
            idempotencyKey,
            accessToken,
          });
          return whatsAppQrCommandResultResponse(result);
        }
        case "check_provider": {
          const permit = await acquireWhatsAppMetaReadLock({
            sourceId: command.sourceId,
            wabaId,
            additionalCooldownUntil: readNonEmptyStringField(
              rawCredentials,
              META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD
            ),
          });
          if (permit.outcome !== "acquired") {
            return NextResponse.json(
              {
                error:
                  "WhatsApp provider status check is temporarily unavailable",
                code:
                  permit.outcome === "in_progress"
                    ? "OPERATION_BUSY"
                    : "PROVIDER_CHECK_UNAVAILABLE",
              },
              { status: permit.outcome === "in_progress" ? 409 : 503 }
            );
          }
          try {
            try {
              const result = await checkWhatsAppQrProviderState({
                workspaceId: command.workspaceId,
                entryPointId: command.entryPointId,
                sourceId: command.sourceId,
                expectedEntryPointVersion: command.expectedEntryPointVersion,
                expectedCodeVersion: command.expectedCodeVersion,
                idempotencyKey,
                accessToken,
                phoneNumberId,
              });
              return whatsAppQrCommandResultResponse(result);
            } catch (error) {
              const rateLimitEvidence = providerRateLimitEvidence(error);
              if (rateLimitEvidence) {
                const now = new Date();
                const fallbackPatch = buildWhatsAppMetaRateLimitCredentialPatch(
                  rawCredentials,
                  {
                    now,
                    error: rateLimitEvidence,
                  }
                );
                const fallbackCooldown = readNonEmptyStringField(
                  fallbackPatch,
                  META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD
                );
                if (fallbackCooldown) {
                  await setCachedWhatsAppMetaReadCooldownUntil(
                    wabaId,
                    fallbackCooldown,
                    { now }
                  ).catch(() => undefined);
                }
                try {
                  const updated = await updateCurrentWhatsAppSourceCredentials({
                    workspaceId: command.workspaceId,
                    sourceId: command.sourceId,
                    expectedWabaId: wabaId,
                    expectedPhoneNumberId: phoneNumberId,
                    buildCredentials: current => ({
                      ...current,
                      ...buildWhatsAppMetaRateLimitCredentialPatch(current, {
                        now,
                        error: rateLimitEvidence,
                      }),
                    }),
                  });
                  const cooldownUntil = readNonEmptyStringField(
                    updated.credentials,
                    META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD
                  );
                  if (cooldownUntil) {
                    await setCachedWhatsAppMetaReadCooldownUntil(
                      wabaId,
                      cooldownUntil,
                      { now }
                    ).catch(() => undefined);
                  }
                } catch {
                  // Preserve the provider result. Persisted credentials are
                  // best-effort here and source binding changes fail closed.
                }
              }
              throw error;
            }
          } finally {
            await releaseWhatsAppMetaReadPermit(permit).catch(() => false);
          }
        }
        case "reconcile": {
          const result = await reconcileWhatsAppQrOperation({
            workspaceId: command.workspaceId,
            entryPointId: command.entryPointId,
            sourceId: command.sourceId,
            operationId: command.operationId,
            accessToken,
            phoneNumberId,
          });
          return whatsAppQrCommandResultResponse(result);
        }
        default: {
          const _exhaustive: never = command;
          return _exhaustive;
        }
      }
    } catch (error) {
      if (error instanceof WhatsAppQrServiceError) {
        return whatsAppQrServiceErrorResponse(error);
      }
      throw error;
    }
  } catch {
    return NextResponse.json(
      { error: "WhatsApp QR command failed", code: "STORAGE_FAILED" },
      { status: 500 }
    );
  }
}
