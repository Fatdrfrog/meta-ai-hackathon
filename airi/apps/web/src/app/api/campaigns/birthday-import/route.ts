import { importCustomerBirthdays } from "@/lib/customers/customer-birthday-import";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

export const runtime = "nodejs";
export const maxDuration = 120;

const BirthdayImportRecipientSchema = z.object({
  phone: z.string().optional(),
  chatId: z.string().optional(),
  sourceId: z.string().optional().nullable(),
  name: z.string().optional(),
  birthday: z.string().optional(),
  fields: z.record(z.string()).optional(),
});

const BirthdayImportBodySchema = z
  .object({
    workspaceId: z.string().min(1),
    channel: z.enum(["whatsapp", "telegram"]).default("whatsapp"),
    sourceId: z.string().min(1).optional(),
    recipients: z.array(BirthdayImportRecipientSchema).min(1).max(10_000),
  })
  .superRefine((value, context) => {
    if (value.channel === "telegram" && !value.sourceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceId"],
        message: "Telegram source is required",
      });
    }
  });

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = BirthdayImportBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid birthday import payload" },
        { status: 400 }
      );
    }

    const allowed = await checkUserWorkspaceAccess(
      supabase,
      user.id,
      parsed.data.workspaceId
    );
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await importCustomerBirthdays({
      workspaceId: parsed.data.workspaceId,
      channel: parsed.data.channel,
      sourceId: parsed.data.sourceId,
      recipients: parsed.data.recipients,
    });

    if (result.imported + result.updated === 0) {
      return NextResponse.json(
        {
          error: "No eligible recipients with valid birthdays were imported",
          code: "BIRTHDAY_IMPORT_NO_VALID_RECIPIENTS",
          ...result,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[Campaign birthday import] Failed", error);
    return NextResponse.json(
      { error: "Failed to import birthdays" },
      { status: 500 }
    );
  }
}
