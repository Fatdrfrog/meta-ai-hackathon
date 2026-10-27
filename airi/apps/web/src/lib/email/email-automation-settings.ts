import connectDB from "@/lib/mongoose";
import WorkspaceEmailAutomation from "@/models/workspace-email-automation";
import {
  DEFAULT_REGISTRATION_FOLLOW_UP_TEMPLATE,
  normalizeEmailAutomationTemplate,
  type EmailAutomationTemplate,
} from "./email-template-rendering";

export type EmailAutomationSettings = {
  registrationFollowUpEnabled: boolean;
  registrationFollowUpTemplate: EmailAutomationTemplate;
};

export type WorkspaceEmailAutomationSettings = EmailAutomationSettings & {
  workspaceId: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

type EmailAutomationSettingsInput = {
  registrationFollowUpEnabled?: boolean;
  registrationFollowUpTemplate?: Partial<EmailAutomationTemplate> | null;
};

type WorkspaceEmailAutomationDocument = {
  workspaceId?: unknown;
  registrationFollowUpEnabled?: unknown;
  registrationFollowUpTemplate?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
};

export const DEFAULT_EMAIL_AUTOMATION_SETTINGS: EmailAutomationSettings = {
  registrationFollowUpEnabled: true,
  registrationFollowUpTemplate: DEFAULT_REGISTRATION_FOLLOW_UP_TEMPLATE,
};

function asTemplateInput(
  value: unknown
): Partial<EmailAutomationTemplate> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  return {
    subject:
      typeof candidate.subject === "string" ? candidate.subject : undefined,
    markdown:
      typeof candidate.markdown === "string" ? candidate.markdown : undefined,
  };
}

export function normalizeEmailAutomationSettings(
  input: EmailAutomationSettingsInput | null | undefined
): EmailAutomationSettings {
  return {
    registrationFollowUpEnabled:
      typeof input?.registrationFollowUpEnabled === "boolean"
        ? input.registrationFollowUpEnabled
        : DEFAULT_EMAIL_AUTOMATION_SETTINGS.registrationFollowUpEnabled,
    registrationFollowUpTemplate: normalizeEmailAutomationTemplate(
      input?.registrationFollowUpTemplate
    ),
  };
}

function serializeWorkspaceEmailAutomationSettings(
  workspaceId: string,
  doc: WorkspaceEmailAutomationDocument | null
): WorkspaceEmailAutomationSettings {
  const normalized = normalizeEmailAutomationSettings({
    registrationFollowUpEnabled:
      typeof doc?.registrationFollowUpEnabled === "boolean"
        ? doc.registrationFollowUpEnabled
        : undefined,
    registrationFollowUpTemplate: asTemplateInput(
      doc?.registrationFollowUpTemplate
    ),
  });

  const updatedAt =
    doc?.updatedAt instanceof Date
      ? doc.updatedAt.toISOString()
      : typeof doc?.updatedAt === "string"
        ? doc.updatedAt
        : null;
  const updatedBy =
    typeof doc?.updatedBy === "string" && doc.updatedBy.trim()
      ? doc.updatedBy
      : null;

  return {
    workspaceId,
    ...normalized,
    updatedAt,
    updatedBy,
  };
}

export async function getWorkspaceEmailAutomationSettings(
  workspaceId: string
): Promise<WorkspaceEmailAutomationSettings> {
  await connectDB();
  const doc = (await WorkspaceEmailAutomation.findOne({
    workspaceId,
  }).lean()) as WorkspaceEmailAutomationDocument | null;

  return serializeWorkspaceEmailAutomationSettings(workspaceId, doc);
}

export async function upsertWorkspaceEmailAutomationSettings(params: {
  workspaceId: string;
  registrationFollowUpEnabled?: boolean;
  registrationFollowUpTemplate?: EmailAutomationTemplate;
  updatedBy: string;
}): Promise<WorkspaceEmailAutomationSettings> {
  await connectDB();
  const $set: Record<string, unknown> = {
    updatedBy: params.updatedBy,
  };

  if (typeof params.registrationFollowUpEnabled === "boolean") {
    $set.registrationFollowUpEnabled = params.registrationFollowUpEnabled;
  }

  if (params.registrationFollowUpTemplate) {
    $set.registrationFollowUpTemplate = normalizeEmailAutomationTemplate(
      params.registrationFollowUpTemplate
    );
  }

  const doc = (await WorkspaceEmailAutomation.findOneAndUpdate(
    { workspaceId: params.workspaceId },
    {
      $set,
      $setOnInsert: {
        workspaceId: params.workspaceId,
      },
    },
    {
      new: true,
      upsert: true,
      lean: true,
    }
  )) as WorkspaceEmailAutomationDocument | null;

  return serializeWorkspaceEmailAutomationSettings(params.workspaceId, doc);
}
