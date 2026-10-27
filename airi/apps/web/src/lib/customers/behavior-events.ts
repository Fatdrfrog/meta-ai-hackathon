import { createHash } from "node:crypto";
import { z } from "zod";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import CustomerEvent from "@/models/customer-event";
import { ensureCustomerForConversation, recordCustomerEvent } from "./service";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";

export const customerBehaviorEventSchema = z
  .object({
    eventId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f]+$/),
    eventType: z.enum([
      "checkout_started",
      "checkout_closed",
      "renewal_scheduled",
      "renewal_completed",
      "service_scheduled",
      "service_completed",
    ]),
    conversationId: z
      .string()
      .regex(/^[a-f0-9]{24}$/i)
      .transform(s => s.toLowerCase()),
    referenceId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f]+$/),
    occurredAt: z
      .string()
      .datetime({ offset: true })
      .transform(s => new Date(s).toISOString()),
    dueAt: z
      .string()
      .datetime({ offset: true })
      .transform(s => new Date(s).toISOString())
      .optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (Date.parse(event.occurredAt) > Date.now())
      ctx.addIssue({
        code: "custom",
        path: ["occurredAt"],
        message: "Future event",
      });
    const scheduled =
      event.eventType === "renewal_scheduled" ||
      event.eventType === "service_scheduled";
    if (scheduled !== Boolean(event.dueAt))
      ctx.addIssue({
        code: "custom",
        path: ["dueAt"],
        message: "Due date is required only for scheduled events",
      });
    if (event.dueAt && Date.parse(event.dueAt) > Date.now() + 730 * 86_400_000)
      ctx.addIssue({
        code: "custom",
        path: ["dueAt"],
        message: "Due date exceeds two years",
      });
  });

export class CustomerBehaviorEventError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Explicit merchant facts, never payment authority. Reuses customer identity and timeline. */
export async function recordCustomerBehaviorEvent(input: {
  workspaceId: string;
  sourceId?: string;
  userId?: string;
  event: unknown;
}) {
  const parsed = customerBehaviorEventSchema.safeParse(input.event);
  if (!parsed.success)
    throw new CustomerBehaviorEventError("Invalid customer event", 400);
  const event = parsed.data;
  await connectDB();
  const conversation = await Conversation.findOne({
    _id: event.conversationId,
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
  })
    .select("sourceId")
    .lean<{ sourceId?: string }>();
  if (!conversation?.sourceId)
    throw new CustomerBehaviorEventError("Conversation not found", 404);
  const customer = await ensureCustomerForConversation({
    conversationId: event.conversationId,
    linkMethod: "system",
  });
  const customerId = (customer as { _id?: unknown } | null)?._id;
  if (!customerId)
    throw new CustomerBehaviorEventError("Customer unavailable", 409);
  const sourceId = conversation.sourceId;
  const idempotencyKey = `behavior:${sourceId}:${event.eventId}`;
  const hash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  try {
    await recordCustomerEvent({
      workspaceId: input.workspaceId,
      customerId: String(customerId),
      type: "commerce_behavior",
      occurredAt: new Date(event.occurredAt),
      conversationId: event.conversationId,
      idempotencyKey,
      payload: { behavior: { ...event, sourceId, hash } },
      actor: input.userId
        ? { type: "manager", userId: input.userId }
        : { type: "system" },
    });
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
  }
  const saved = await CustomerEvent.findOne({
    workspaceId: input.workspaceId,
    idempotencyKey,
  }).lean<{ _id: unknown; payload?: { behavior?: { hash?: string } } }>();
  if (saved?.payload?.behavior?.hash !== hash)
    throw new CustomerBehaviorEventError(
      "Event ID already has different facts",
      409
    );
  return { success: true, eventId: String(saved._id) };
}
