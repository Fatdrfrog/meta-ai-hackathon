/**
 * @jest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import {
  CampaignRecipientPicker,
  contactMatchesCampaignAudience,
  type CampaignRecipient,
  type CampaignUploadedAudience,
} from "./campaign-recipient-picker";
import type { CampaignVariableSourceConfig } from "@icecore/scenario-contracts";
import { toast } from "sonner";

jest.mock("sonner", () => ({
  toast: Object.assign(
    jest.fn(() => "undo-toast"),
    { dismiss: jest.fn() }
  ),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "recipient.selectedCount"
      ? `${values?.selected} selected / ${values?.limit}`
      : key === "recipient.attachedCount"
        ? `${values?.count} recipients attached`
        : key === "recipient.pageStatus"
          ? `page ${values?.page} of ${values?.total}`
          : key === "recipient.renameColumn"
            ? `rename ${values?.column}`
            : key === "recipient.variableMatchStatus"
              ? `match ${values?.variable}`
            : key === "recipient.overflowQueueHint"
              ? `${values?.count} exceed ${values?.limit}`
              : key === "recipientCount" || key === "mergedDuplicates"
                ? `${key}:${values?.count}`
                : key,
}));

const batchPlanResponse = {
  configured: true,
  recipientLimit: {
    maxRecipients: 1000,
    rawLimit: "1000",
    source: "channel_default" as const,
  },
};

const contactsResponse = {
  data: [
    {
      identifier: "+77009990000",
      name: "Existing Lead",
      channel: "whatsapp",
    },
  ],
};

function mockFetch() {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/contacts")) {
      return {
        ok: true,
        json: async () => contactsResponse,
      } as Response;
    }
    if (url.includes("/api/campaigns/batch-plan")) {
      return {
        ok: true,
        json: async () => batchPlanResponse,
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as jest.Mock;
}

function mockFetchWithContacts(contacts: unknown[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/contacts")) {
      return {
        ok: true,
        json: async () => ({ data: contacts }),
      } as Response;
    }
    if (url.includes("/api/campaigns/batch-plan")) {
      return {
        ok: true,
        json: async () => batchPlanResponse,
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as jest.Mock;
}

function createCsvFile(contents: string, name = "recipients.csv") {
  const file = new File([contents], name, {
    type: "text/csv",
  });
  Object.defineProperty(file, "text", {
    value: async () => contents,
  });
  return file;
}

function ControlledEvidencePicker({
  initialRecipients = [],
  initialEvidence = null,
  sourceIds,
}: {
  sourceIds?: string[];
  initialRecipients?: CampaignRecipient[];
  initialEvidence?: {
    originalFilename?: string;
    selectedAt?: string;
    replacementHistory?: Array<{
      action: "replaced" | "cleared";
      replacedAt: string;
      previousFilename?: string;
      nextFilename?: string;
    }>;
  } | null;
}) {
  const [recipients, setRecipients] =
    useState<CampaignRecipient[]>(initialRecipients);
  const [uploadEvidence, setUploadEvidence] = useState(initialEvidence);

  return (
    <>
      <output data-testid="evidence-state">
        {JSON.stringify({ recipients, uploadEvidence })}
      </output>
      <CampaignRecipientPicker
        workspaceId="11111111-1111-4111-8111-111111111111"
        channel="whatsapp"
        sourceIds={sourceIds}
        recipients={recipients}
        onRecipientsChange={setRecipients}
        audienceUploadEvidence={uploadEvidence}
        onUploadedAudienceChange={next => {
          setRecipients(next.recipients);
          setUploadEvidence(next.uploadEvidence);
        }}
        compact
        mode="upload"
        variant="chat"
        showHeader={false}
        recipientLimitState={{
          preview: batchPlanResponse.recipientLimit,
          loading: false,
          error: null,
        }}
      />
    </>
  );
}

function ControlledPicker({
  templateVariables = [],
  initialRecipients = [],
  channel = "whatsapp",
  sourceIds,
}: {
  templateVariables?: string[];
  initialRecipients?: CampaignRecipient[];
  channel?: "whatsapp" | "telegram" | "email";
  sourceIds?: string[];
}) {
  const [recipients, setRecipients] =
    useState<CampaignRecipient[]>(initialRecipients);
  const [variableConfigs, setVariableConfigs] = useState<
    Record<string, CampaignVariableSourceConfig>
  >({});

  return (
    <>
      <output data-testid="recipient-payload">{JSON.stringify(recipients)}</output>
      <CampaignRecipientPicker
        workspaceId="11111111-1111-4111-8111-111111111111"
        channel={channel}
        sourceIds={sourceIds}
        recipients={recipients}
        onRecipientsChange={setRecipients}
        templateVariables={templateVariables}
        variableConfigs={variableConfigs}
        onVariableConfigsChange={setVariableConfigs}
      />
    </>
  );
}

function ControlledEmailPicker() {
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  const [audienceSource, setAudienceSource] = useState<
    "manual" | "registered_users"
  >("manual");
  const [selectedRegisteredUserIds, setSelectedRegisteredUserIds] = useState([
    "auth-user-1",
    "auth-user-2",
  ]);

  return (
    <CampaignRecipientPicker
      workspaceId="11111111-1111-4111-8111-111111111111"
      channel="email"
      recipients={recipients}
      onRecipientsChange={setRecipients}
      {...({
        audienceSource,
        onAudienceSourceChange: setAudienceSource,
        registeredUsersAudience: {
          enabled: true,
          total: 2,
          totalAuthUsers: 3,
          skippedUnconfirmed: 1,
          skippedInvalidEmail: 0,
          skippedAnonymous: 0,
          skippedDuplicate: 0,
          preview: [
            {
              userId: "auth-user-1",
              email: "founder@example.com",
              name: "Founder User",
              registeredAt: "2026-01-01T00:00:00.000Z",
            },
            {
              userId: "auth-user-2",
              email: "teammate@example.com",
              name: "Team Mate",
              registeredAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        },
        selectedRegisteredUserIds,
        onSelectedRegisteredUserIdsChange: setSelectedRegisteredUserIds,
      } as Record<string, unknown>)}
    />
  );
}

function UploadOnlyChatPicker() {
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  return (
    <CampaignRecipientPicker
      workspaceId="11111111-1111-4111-8111-111111111111"
      channel="whatsapp"
      recipients={recipients}
      onRecipientsChange={setRecipients}
      compact
      mode="upload"
      variant="chat"
      showHeader={false}
      showSelectedRecipientsTable={false}
      recipientLimitState={{
        preview: batchPlanResponse.recipientLimit,
        loading: false,
        error: null,
      }}
    />
  );
}

function collectAncestorClassNames(element: Element): string[] {
  const classNames: string[] = [];
  let current = element.parentElement;
  while (current) {
    if (current.className) {
      classNames.push(String(current.className));
    }
    current = current.parentElement;
  }
  return classNames;
}

async function waitForInitialLoads() {
  await screen.findByText("0 selected / 1000");
}

describe("CampaignRecipientPicker", () => {
  it("shows an international phone once while retaining actual corrected digits", async () => {
    render(<ControlledPicker initialRecipients={[{ phone: "+77001234567" }, { phone: "87009990000" }]} />);
    const table = await screen.findByRole("table");
    const internationalPhoneCell = within(table).getByText("+77001234567").closest("td")!;
    expect(within(internationalPhoneCell).getAllByText("+77001234567")).toHaveLength(1);
    expect(within(internationalPhoneCell).queryByText("77001234567")).toBeNull();
    const correctedPhoneCell = within(table).getByText("77009990000").closest("td")!;
    expect(within(correctedPhoneCell).getByText("77009990000")).toBeTruthy();
    expect(within(correctedPhoneCell).getByText("87009990000")).toBeTruthy();
    expect(table.className).not.toContain("min-w-[720px]");
    expect(table.className).toContain("min-w-full");
  });

  it("does not reserve a full contacts scroll panel for an empty list", async () => {
    mockFetchWithContacts([]);
    render(<ControlledPicker />);
    const empty = await screen.findByText("recipient.noContacts");
    const scrollArea = empty.closest('[data-slot="scroll-area"]');
    expect(scrollArea?.className).not.toMatch(/h-40|h-52/);
  });

  it("explains merged duplicate rows and shows an uploaded file's count once", async () => {
    mockFetch();
    function ControlledUploadPicker() {
      const [audience, setAudience] = useState<CampaignUploadedAudience>({
        recipients: [],
        uploadEvidence: null,
      });
      return (
        <CampaignRecipientPicker
          workspaceId="workspace-1"
          channel="whatsapp"
          variant="chat"
          mode="upload"
          compact
          showHeader={false}
          recipients={audience.recipients}
          onRecipientsChange={recipients =>
            setAudience({ recipients, uploadEvidence: null })
          }
          audienceUploadEvidence={audience.uploadEvidence}
          onUploadedAudienceChange={setAudience}
          recipientLimitState={{
            preview: batchPlanResponse.recipientLimit,
            loading: false,
            error: null,
          }}
        />
      );
    }
    const { container } = render(<ControlledUploadPicker />);
    const file = new File([], "audience.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", {
      value: async () =>
        "phone,name\n+77001234567,Aibek\n+77001234568,Samat\n+77001234567,Aibek",
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    expect(await screen.findByText("audience.csv")).toBeTruthy();
    expect(
      screen.getByText("recipientCount:2 · mergedDuplicates:1")
    ).toBeTruthy();
    expect(screen.queryByText("2 recipients attached")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "recipient.clearAll" })
    ).toBeNull();
  });

  it("shows one audience count and clear action when upload and contacts are both available", async () => {
    mockFetch();
    render(
      <CampaignRecipientPicker
        workspaceId="workspace-1"
        channel="whatsapp"
        variant="chat"
        showHeader={false}
        recipients={[{ phone: "77009990000" }]}
        onRecipientsChange={jest.fn()}
      />
    );
    await screen.findByText("Existing Lead");
    expect(screen.getAllByText("1 recipients attached")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "recipient.clearAll" })).toHaveLength(1);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = jest.fn();
    mockFetch();
  });

  it("renders one unified recipient workspace without recipient method tabs", async () => {
    render(<ControlledPicker />);
    await waitForInitialLoads();

    expect(screen.queryByRole("tab", { name: "CSV Upload" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Manual Entry" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Manual Select" })).toBeNull();
    expect(screen.getByLabelText("recipient.quickAddLabel")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "recipient.addRecipient" })
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      collectAncestorClassNames(screen.getByText("dropzoneTitle")).some(
        className => className.includes("xl:grid-cols")
      )
    ).toBe(true);
  });

  it("keeps attached recipients above the daily send cap and shows the overflow hint", async () => {
    const onRecipientsChange = jest.fn();
    render(
      <CampaignRecipientPicker
        workspaceId="11111111-1111-4111-8111-111111111111"
        channel="whatsapp"
        recipients={[
          { phone: "+77000000001" },
          { phone: "+77000000002" },
          { phone: "+77000000003" },
        ]}
        onRecipientsChange={onRecipientsChange}
        recipientLimit={50_000}
        recipientLimitState={{
          preview: {
            maxRecipients: 2,
            rawLimit: "2",
            source: "live_meta",
          },
          loading: false,
          error: null,
        }}
      />
    );

    expect(await screen.findByText("3 selected / 2")).toBeTruthy();
    expect(screen.getByText("3 exceed 2")).toBeTruthy();
    expect(onRecipientsChange).not.toHaveBeenCalled();
  });

  it("keeps the full-page chat picker split with contacts and quick-add", async () => {
    render(
      <CampaignRecipientPicker
        workspaceId="11111111-1111-4111-8111-111111111111"
        channel="whatsapp"
        recipients={[]}
        onRecipientsChange={jest.fn()}
        variant="chat"
        recipientLimitState={{
          preview: batchPlanResponse.recipientLimit,
          loading: false,
          error: null,
        }}
      />
    );
    await waitForInitialLoads();

    expect(screen.getByLabelText("recipient.quickAddLabel")).toBeTruthy();
    expect(screen.getByText("recipient.contactsTitle")).toBeTruthy();
    expect(screen.getByText("dropzoneTitle")).toBeTruthy();
    expect(
      collectAncestorClassNames(screen.getByText("dropzoneTitle")).some(
        className => className.includes("xl:grid-cols")
      )
    ).toBe(true);
  });

  it("lets upload-only chat layouts use the full node width", () => {
    render(<UploadOnlyChatPicker />);

    const uploadTitle = screen.getByText("dropzoneTitle");
    const ancestorClassNames = collectAncestorClassNames(uploadTitle);

    expect(
      ancestorClassNames.some(className => className.includes("lg:grid-cols"))
    ).toBe(false);
    expect(
      ancestorClassNames.some(className => className.includes("xl:grid-cols"))
    ).toBe(false);
  });

  it("does not show contacts or quick-add in compact chat layouts unless select mode is set", () => {
    render(
      <CampaignRecipientPicker
        workspaceId="11111111-1111-4111-8111-111111111111"
        channel="whatsapp"
        recipients={[]}
        onRecipientsChange={jest.fn()}
        compact
        variant="chat"
        showHeader={false}
        showSelectedRecipientsTable={false}
        recipientLimitState={{
          preview: batchPlanResponse.recipientLimit,
          loading: false,
          error: null,
        }}
      />
    );

    expect(screen.getByText("dropzoneTitle")).toBeTruthy();
    expect(screen.queryByText("recipient.contactsTitle")).toBeNull();
    expect(screen.queryByLabelText("recipient.quickAddLabel")).toBeNull();
  });

  it("shows contacts without the upload dropzone in chat select mode", async () => {
    mockFetchWithContacts([
      {
        identifier: "77002220000",
        name: "Matching WhatsApp",
        channel: "whatsapp",
        sourceId: "wa-1",
      },
    ]);

    render(
      <CampaignRecipientPicker
        workspaceId="11111111-1111-4111-8111-111111111111"
        channel="whatsapp"
        sourceIds={["wa-1"]}
        recipients={[]}
        onRecipientsChange={jest.fn()}
        compact
        mode="select"
        variant="chat"
        showHeader={false}
        showSelectedRecipientsTable={false}
        recipientLimitState={{
          preview: batchPlanResponse.recipientLimit,
          loading: false,
          error: null,
        }}
      />
    );

    expect(screen.queryByText("dropzoneTitle")).toBeNull();
    expect(await screen.findByText("recipient.contactsTitle")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /Matching WhatsApp/ })
    ).toBeTruthy();
  });

  it("replaces previous uploaded recipients when a new CSV is loaded", async () => {
    function PickerWithSeed() {
      const [recipients, setRecipients] = useState<CampaignRecipient[]>([
        { phone: "77001111111", name: "Old One" },
        { phone: "77002222222", name: "Old Two" },
      ]);
      return (
        <CampaignRecipientPicker
          workspaceId="11111111-1111-4111-8111-111111111111"
          channel="whatsapp"
          recipients={recipients}
          onRecipientsChange={setRecipients}
          compact
          mode="upload"
          variant="chat"
          showHeader={false}
          showSelectedRecipientsTable={false}
          recipientLimitState={{
            preview: batchPlanResponse.recipientLimit,
            loading: false,
            error: null,
          }}
        />
      );
    }

    const { container } = render(<PickerWithSeed />);

    expect(screen.getByText("2 recipients attached")).toBeTruthy();

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [createCsvFile("phone,name\n+77010000201,Only Me")],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("1 recipients attached")).toBeTruthy();
    });
    expect(screen.queryByText("2 recipients attached")).toBeNull();
  });

  it("replaces recipients and evidence atomically while preserving bounded history", async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      action: "replaced" as const,
      replacedAt: `2026-07-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      previousFilename: `audience-${index}.csv`,
      nextFilename: `audience-${index + 1}.csv`,
    }));
    const { container } = render(
      <ControlledEvidencePicker
        initialRecipients={[{ phone: "77001111111", name: "Old" }]}
        initialEvidence={{
          originalFilename: "old.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
          replacementHistory: history,
        }}
      />
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, {
      target: {
        files: [
          createCsvFile("phone,name\n+77010000201,Only Me", "replacement.csv"),
        ],
      },
    });

    await waitFor(() => {
      const state = JSON.parse(
        screen.getByTestId("evidence-state").textContent || "{}"
      );
      expect(state.recipients).toEqual([
        expect.objectContaining({ phone: "+77010000201", name: "Only Me" }),
      ]);
      expect(state.uploadEvidence).toMatchObject({
        originalFilename: "replacement.csv",
        selectedAt: expect.any(String),
      });
      expect(state.uploadEvidence.replacementHistory).toHaveLength(25);
      expect(state.uploadEvidence.replacementHistory[24]).toMatchObject({
        action: "replaced",
        previousFilename: "old.csv",
        nextFilename: "replacement.csv",
      });
    });
  });

  it("clears recipients and current-file evidence after a failed replacement", async () => {
    const { container } = render(
      <ControlledEvidencePicker
        initialRecipients={[{ phone: "77001111111", name: "Old" }]}
        initialEvidence={{
          originalFilename: "accepted.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        }}
      />
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, {
      target: {
        files: [createCsvFile("name\nMissing phone", "broken.csv")],
      },
    });

    expect(await screen.findByText("errors.whatsappMissingPhone")).toBeTruthy();
    const state = JSON.parse(
      screen.getByTestId("evidence-state").textContent || "{}"
    );
    expect(state.recipients).toEqual([]);
    expect(state.uploadEvidence.originalFilename).toBeUndefined();
    expect(state.uploadEvidence.replacementHistory).toEqual([
      {
        action: "cleared",
        previousFilename: "accepted.csv",
        replacedAt: expect.any(String),
      },
    ]);
    expect(screen.queryByText("accepted.csv")).toBeNull();
  });

  it("clears stale current-file evidence when a recipient is manually removed", async () => {
    render(
      <ControlledEvidencePicker
        initialRecipients={[{ phone: "77001111111", name: "Old" }]}
        initialEvidence={{
          originalFilename: "accepted.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "recipient.removeRecipient" })
    );

    await waitFor(() => {
      const state = JSON.parse(
        screen.getByTestId("evidence-state").textContent || "{}"
      );
      expect(state.recipients).toHaveLength(0);
      expect(state.uploadEvidence).toEqual({
        replacementHistory: [
          expect.objectContaining({
            action: "cleared",
            previousFilename: "accepted.csv",
          }),
        ],
      });
    });
    expect(screen.queryByText("accepted.csv")).toBeNull();
  });

  it("clears all attached recipients from the upload panel", async () => {
    function PickerWithSeed() {
      const [recipients, setRecipients] = useState<CampaignRecipient[]>([
        { phone: "77001111111", name: "Old One" },
        { phone: "77002222222", name: "Old Two" },
      ]);
      return (
        <CampaignRecipientPicker
          workspaceId="11111111-1111-4111-8111-111111111111"
          channel="whatsapp"
          recipients={recipients}
          onRecipientsChange={setRecipients}
          compact
          mode="upload"
          variant="chat"
          showHeader={false}
          showSelectedRecipientsTable={false}
          recipientLimitState={{
            preview: batchPlanResponse.recipientLimit,
            loading: false,
            error: null,
          }}
        />
      );
    }

    render(<PickerWithSeed />);

    expect(screen.getByText("2 recipients attached")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "recipient.clearAll" }));
    await waitFor(() => {
      expect(screen.queryByText("2 recipients attached")).toBeNull();
    });
  });

  function readEvidenceState() {
    return JSON.parse(
      screen.getByTestId("evidence-state").textContent || "{}"
    ) as {
      recipients: CampaignRecipient[];
      uploadEvidence: Record<string, unknown> | null;
    };
  }

  function lastUndoToast() {
    const calls = jest.mocked(toast).mock.calls as unknown as Array<
      [string, { action: { label: string; onClick: () => void } }]
    >;
    const call = calls.at(-1);
    if (!call) throw new Error("Expected an undo toast");
    return { message: call[0], action: call[1].action };
  }

  it("puts back all cleared recipients and their record from the toast", async () => {
    const initialRecipients = [
      { phone: "77001111111", name: "Old One" },
      { phone: "77002222222", name: "Old Two" },
    ];
    const initialEvidence = {
      replacementHistory: [
        {
          action: "cleared" as const,
          replacedAt: "2026-07-24T08:00:00.000Z",
          previousFilename: "earlier.csv",
        },
      ],
    };
    render(
      <ControlledEvidencePicker
        initialRecipients={initialRecipients}
        initialEvidence={initialEvidence}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "recipient.clearAll" }));
    expect(readEvidenceState().recipients).toEqual([]);
    const undo = lastUndoToast();
    expect(undo.message).toBe("recipient.clearedToast");
    expect(undo.action.label).toBe("recipient.undoClear");

    act(() => undo.action.onClick());

    expect(readEvidenceState()).toEqual({
      recipients: initialRecipients,
      uploadEvidence: initialEvidence,
    });
    expect(screen.getByText("2 recipients attached")).toBeTruthy();
  });

  it("puts back a cleared file and its recipients exactly from the toast", async () => {
    const initialRecipients = [{ phone: "77001111111", name: "Old" }];
    const initialEvidence = {
      originalFilename: "accepted.csv",
      selectedAt: "2026-07-24T08:00:00.000Z",
    };
    render(
      <ControlledEvidencePicker
        initialRecipients={initialRecipients}
        initialEvidence={initialEvidence}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "clearFile" }));
    expect(readEvidenceState().recipients).toEqual([]);
    expect(screen.queryByText("accepted.csv")).toBeNull();

    act(() => lastUndoToast().action.onClick());

    expect(readEvidenceState()).toEqual({
      recipients: initialRecipients,
      uploadEvidence: initialEvidence,
    });
    expect(screen.getByText("accepted.csv")).toBeTruthy();
  });

  it("keeps a newer upload when an old clear is undone", async () => {
    const { container } = render(
      <ControlledEvidencePicker
        initialRecipients={[{ phone: "77001111111", name: "Old" }]}
        initialEvidence={{
          originalFilename: "accepted.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "clearFile" }));
    const undo = lastUndoToast();
    fireEvent.change(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      {
        target: {
          files: [createCsvFile("phone,name\n+77010000201,New", "new.csv")],
        },
      }
    );
    await screen.findByText("new.csv");

    act(() => undo.action.onClick());

    expect(readEvidenceState().recipients).toEqual([
      expect.objectContaining({ phone: "+77010000201", name: "New" }),
    ]);
    expect(screen.getByText("new.csv")).toBeTruthy();
  });

  it("withdraws the undo and keeps the list out of another number's audience", async () => {
    const initialRecipients = [{ phone: "77001111111", name: "Old" }];
    const { rerender } = render(
      <ControlledEvidencePicker
        sourceIds={["number-a"]}
        initialRecipients={initialRecipients}
        initialEvidence={{
          originalFilename: "accepted.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "clearFile" }));
    const undo = lastUndoToast();
    expect(toast.dismiss).not.toHaveBeenCalled();

    // The picker stays mounted while the WhatsApp number changes.
    rerender(
      <ControlledEvidencePicker
        sourceIds={["number-b"]}
        initialRecipients={initialRecipients}
      />
    );
    expect(toast.dismiss).toHaveBeenCalledWith("undo-toast");

    act(() => undo.action.onClick());
    expect(readEvidenceState().recipients).toEqual([]);
    expect(screen.queryByText("accepted.csv")).toBeNull();
  });

  it("withdraws the undo once a newer list replaces the cleared one", async () => {
    const { container } = render(
      <ControlledEvidencePicker
        initialRecipients={[{ phone: "77001111111", name: "Old" }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "recipient.clearAll" }));
    expect(toast.dismiss).not.toHaveBeenCalled();
    fireEvent.change(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      {
        target: {
          files: [createCsvFile("phone,name\n+77010000201,New", "new.csv")],
        },
      }
    );
    await screen.findByText("new.csv");

    expect(toast.dismiss).toHaveBeenCalledWith("undo-toast");
  });

  it("doesn't offer an undo when there was nothing to clear", async () => {
    const { container } = render(
      <ControlledEvidencePicker initialRecipients={[]} initialEvidence={null} />
    );

    fireEvent.change(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      {
        target: { files: [createCsvFile("name\nMissing phone", "bad.csv")] },
      }
    );

    expect(await screen.findByText("errors.whatsappMissingPhone")).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });

  it("disables conflicting audience edits until a pending upload completes", async () => {
    const { container } = render(
      <ControlledPicker
        initialRecipients={[
          { phone: "77009998877", fields: { company: "Old" } },
        ]}
      />
    );
    await screen.findByText("1 selected / 1000");
    let finishRead!: (text: string) => void;
    const file = new File([], "pending.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", {
      value: () =>
        new Promise<string>(resolve => {
          finishRead = resolve;
        }),
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    const clearButton = screen.getByRole("button", {
      name: "recipient.clearAll",
    }) as HTMLButtonElement;
    expect(clearButton.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "recipient.removeRecipient",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      (screen.getByLabelText("rename company") as HTMLInputElement).disabled
    ).toBe(true);
    expect(
      (screen.getByLabelText("recipient.quickAddLabel") as HTMLInputElement)
        .disabled
    ).toBe(true);
    fireEvent.click(clearButton);
    expect(
      JSON.parse(screen.getByTestId("recipient-payload").textContent || "[]")
    ).toHaveLength(1);
    await act(async () => finishRead("phone\n+77001234567"));
    expect(clearButton.disabled).toBe(false);
    fireEvent.click(clearButton);
    expect(
      JSON.parse(screen.getByTestId("recipient-payload").textContent || "[]")
    ).toEqual([]);
  });

  it("discards a pending upload when the picker switches to contacts", async () => {
    const onRecipientsChange = jest.fn();
    const onParsingChange = jest.fn();
    const props = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      channel: "whatsapp" as const,
      recipients: [],
      onRecipientsChange,
      onParsingChange,
      recipientLimitState: {
        preview: batchPlanResponse.recipientLimit,
        loading: false,
        error: null,
      },
    };
    const { container, rerender } = render(
      <CampaignRecipientPicker {...props} mode="upload" />
    );
    let finishRead!: (text: string) => void;
    const file = new File([], "pending.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", {
      value: () =>
        new Promise<string>(resolve => {
          finishRead = resolve;
        }),
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    rerender(<CampaignRecipientPicker {...props} mode="select" />);
    await act(async () => finishRead("phone\n+77001234567"));
    expect(onRecipientsChange).not.toHaveBeenCalled();
    expect(onParsingChange.mock.calls.map(call => call[0])).toEqual([
      true,
      false,
    ]);
  });

  it("offers registered app users inside the email recipient picker", async () => {
    render(<ControlledEmailPicker />);
    await screen.findByText("0 selected / 1000");

    expect(
      screen.getByRole("button", { name: "Build custom list" })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Registered app users" })
    );

    expect(await screen.findByText("Registered users preview")).toBeTruthy();
    expect(screen.getByText("founder@example.com")).toBeTruthy();
    expect(screen.getByText("Founder User")).toBeTruthy();
    expect(screen.getByText("2 selected / 2 eligible users")).toBeTruthy();
    expect(screen.queryByLabelText("recipient.quickAddLabel")).toBeNull();
  });

  it("selects and deselects registered app users from the preview list", async () => {
    render(<ControlledEmailPicker />);
    await screen.findByText("0 selected / 1000");
    fireEvent.click(
      screen.getByRole("button", { name: "Registered app users" })
    );

    expect(
      await screen.findByText("2 selected / 2 eligible users")
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select founder@example.com" })
    );
    expect(
      await screen.findByText("1 selected / 2 eligible users")
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter registered users"), {
      target: { value: "team" },
    });
    expect(screen.queryByText("founder@example.com")).toBeNull();
    expect(screen.getByText("teammate@example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Deselect shown" }));
    expect(
      await screen.findByText("0 selected / 2 eligible users")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(
      await screen.findByText("2 selected / 2 eligible users")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(
      await screen.findByText("0 selected / 2 eligible users")
    ).toBeTruthy();
  });

  it("adds a quick recipient into the selected-recipient table", async () => {
    render(<ControlledPicker />);
    await waitForInitialLoads();

    fireEvent.change(screen.getByLabelText("recipient.quickAddLabel"), {
      target: { value: "+77001234567" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "recipient.addRecipient" })
    );

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByText("+77001234567")).toBeTruthy();
  });

  it("shows the normalized send target and deduplicates phone formats with or without plus", async () => {
    render(<ControlledPicker />);
    await waitForInitialLoads();

    const input = screen.getByLabelText("recipient.quickAddLabel");
    fireEvent.change(input, {
      target: { value: "+77001234567" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "recipient.addRecipient" })
    );
    fireEvent.change(input, {
      target: { value: "77001234567" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "recipient.addRecipient" })
    );

    const targetCell = await screen.findByText("77001234567");
    expect(targetCell.closest("td")?.className).toContain("bg-emerald-500/10");
    expect(screen.getByText("1 selected / 1000")).toBeTruthy();
    expect(screen.queryByText("787001234567")).toBeNull();
    expect(JSON.parse(screen.getByTestId("recipient-payload").textContent || "[]"))
      .toEqual([expect.objectContaining({ phone: "77001234567" })]);
  });

  it("marks malformed WhatsApp recipients in the send target column", async () => {
    render(<ControlledPicker />);
    await waitForInitialLoads();

    fireEvent.change(screen.getByLabelText("recipient.quickAddLabel"), {
      target: { value: "broken-number" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "recipient.addRecipient" })
    );

    const targetCell = await screen.findByText("broken-number");
    expect(targetCell.closest("td")?.className).toContain("bg-rose-500/10");
  });

  it("imports CSV rows into the same selected-recipient table with dynamic columns", async () => {
    const { container } = render(<ControlledPicker />);
    await waitForInitialLoads();
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    const file = createCsvFile(
      "phone,name,company\n'+77001234567,Aibek,TechCorp"
    );
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByText("+77001234567")).toBeTruthy();
    expect(screen.queryByText("787001234567")).toBeNull();
    expect(JSON.parse(screen.getByTestId("recipient-payload").textContent || "[]"))
      .toEqual([expect.objectContaining({ phone: "+77001234567" })]);
    expect(screen.getByText("Aibek")).toBeTruthy();
    expect(screen.getByDisplayValue("company")).toBeTruthy();
    expect(screen.getByText("TechCorp")).toBeTruthy();
  });

  it("adds an existing contact from the side picker into the selected-recipient table", async () => {
    render(<ControlledPicker />);
    await waitForInitialLoads();

    fireEvent.click(
      await screen.findByRole("button", { name: /Existing Lead/ })
    );

    const table = await screen.findByRole("table");
    expect(within(table).getByText("+77009990000")).toBeTruthy();
  });

  it("loads Telegram contacts for the selected bot and explains empty eligibility", async () => {
    mockFetchWithContacts([]);

    render(
      <ControlledPicker channel="telegram" sourceIds={["telegram-source-1"]} />
    );
    await waitForInitialLoads();

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("channel=telegram")
      )
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("sourceIds=telegram-source-1")
    );
    expect(screen.getByText("recipient.noTelegramContacts")).toBeTruthy();
  });

  it("hides contacts that belong to another channel or source", async () => {
    mockFetchWithContacts([
      {
        identifier: "ig-user",
        name: "Instagram Lead",
        channel: "instagram",
        sourceId: "ig-1",
      },
      {
        identifier: "12345",
        name: "Telegram Lead",
        channel: "telegram",
        sourceId: "tg-1",
      },
      {
        identifier: "77001110000",
        name: "Other WhatsApp",
        channel: "whatsapp",
        sourceId: "wa-other",
      },
      {
        identifier: "77002220000",
        name: "Matching WhatsApp",
        channel: "whatsapp",
        sourceId: "wa-1",
      },
      {
        identifier: "@Ultrapara",
        name: "@Ultrapara",
        channel: "whatsapp",
        sourceId: "wa-1",
      },
    ]);

    render(<ControlledPicker sourceIds={["wa-1"]} />);
    await waitForInitialLoads();

    expect(
      await screen.findByRole("button", { name: /Matching WhatsApp/ })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Instagram Lead/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Telegram Lead/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Other WhatsApp/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ultrapara/ })).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("channel=whatsapp")
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("sourceIds=wa-1")
    );
  });

  it("matches contacts only when channel and source agree", () => {
    expect(
      contactMatchesCampaignAudience(
        { channel: "instagram", sourceId: "ig-1" },
        "whatsapp",
        ["wa-1"]
      )
    ).toBe(false);
    expect(
      contactMatchesCampaignAudience(
        { channel: "whatsapp", sourceId: "wa-other" },
        "whatsapp",
        ["wa-1"]
      )
    ).toBe(false);
    expect(
      contactMatchesCampaignAudience(
        { channel: "whatsapp", sourceId: "wa-1" },
        "whatsapp",
        ["wa-1"]
      )
    ).toBe(true);
  });

  it("uses the phone label for Unknown WhatsApp contacts without mapping Unknown as a name", async () => {
    mockFetchWithContacts([
      {
        identifier: "wa_77009990000",
        name: "Unknown",
        channel: "whatsapp",
      },
    ]);

    render(<ControlledPicker templateVariables={["name"]} />);
    await waitForInitialLoads();

    expect(
      await screen.findByRole("button", { name: "77009990000" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unknown/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "77009990000" }));

    const table = await screen.findByRole("table");
    expect(within(table).getByText("77009990000")).toBeTruthy();
    expect(within(table).queryByText("Unknown")).toBeNull();
    expect(screen.getByLabelText("match name").className).toContain(
      "bg-rose-500/10"
    );
  });

  it("hides punctuation-only contact names so the phone sits on one line", async () => {
    mockFetchWithContacts([
      {
        identifier: "992905111111",
        name: ".",
        channel: "whatsapp",
      },
    ]);

    render(<ControlledPicker />);
    await waitForInitialLoads();

    const contactButton = await screen.findByRole("button", {
      name: "992905111111",
    });
    expect(contactButton.textContent).toBe("992905111111");
    expect(contactButton.className).toContain("items-center");
  });

  it("adds all visible contacts from the existing contacts panel", async () => {
    mockFetchWithContacts([
      {
        identifier: "wa_77009990000",
        name: "Aibek",
        channel: "whatsapp",
      },
      {
        identifier: "wa_77008880000",
        name: "Unknown",
        channel: "whatsapp",
      },
    ]);

    render(<ControlledPicker />);
    await waitForInitialLoads();

    const addShownContacts = await screen.findByRole("button", {
      name: "recipient.addShownContacts",
    });
    expect(addShownContacts.className).toContain("shrink-0");
    fireEvent.click(addShownContacts);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("77009990000")).toBeTruthy();
    expect(within(table).getByText("77008880000")).toBeTruthy();
    expect(screen.getByText("2 selected / 1000")).toBeTruthy();
  });

  it("removes a selected recipient from the table", async () => {
    render(<ControlledPicker />);
    await waitForInitialLoads();

    fireEvent.change(screen.getByLabelText("recipient.quickAddLabel"), {
      target: { value: "+77001234567" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "recipient.addRecipient" })
    );
    expect(await screen.findByText("+77001234567")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "recipient.removeRecipient" })
    );

    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  });

  it("lets template variables map to selected table columns", async () => {
    const { container } = render(
      <ControlledPicker templateVariables={["1"]} />
    );
    await waitForInitialLoads();
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    const file = createCsvFile(
      "phone,name,company\n+77001234567,Aibek,TechCorp"
    );
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    fireEvent.click(await screen.findByRole("combobox", { name: "{{1}}" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "recipient.tableColumn" })
    );
    fireEvent.click(
      await screen.findByRole("combobox", { name: "recipient.tableColumn" })
    );
    fireEvent.click(await screen.findByRole("option", { name: "company" }));

    expect(screen.getAllByText("company").length).toBeGreaterThan(0);
  });

  it("paginates selected recipients and keeps row actions sticky", async () => {
    render(
      <ControlledPicker
        initialRecipients={Array.from({ length: 12 }, (_, index) => ({
          phone: `+770012345${String(index).padStart(2, "0")}`,
        }))}
      />
    );
    await screen.findByText("12 selected / 1000");

    expect(screen.getByText("+77001234500")).toBeTruthy();
    expect(screen.queryByText("+77001234510")).toBeNull();
    expect(screen.getByText("page 1 of 2")).toBeTruthy();

    const removeButton = screen.getAllByRole("button", {
      name: "recipient.removeRecipient",
    })[0];
    expect(removeButton.closest("td")?.className).toContain("sticky");

    fireEvent.click(screen.getByRole("button", { name: "recipient.nextPage" }));

    expect(await screen.findByText("+77001234510")).toBeTruthy();
    expect(screen.queryByText("+77001234500")).toBeNull();
    expect(screen.getByText("page 2 of 2")).toBeTruthy();
  });

  it("shows exact variable-column matches and updates immediately when a column is renamed", async () => {
    const { container } = render(
      <ControlledPicker templateVariables={["company"]} />
    );
    await waitForInitialLoads();
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    const file = createCsvFile("phone,company\n+77001234567,TechCorp");
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    const matchStatus = await screen.findByLabelText("match company");
    await waitFor(() =>
      expect(matchStatus.className).toContain("bg-emerald-500/10")
    );

    fireEvent.change(screen.getByLabelText("rename company"), {
      target: { value: "company_name" },
    });

    expect(screen.getByLabelText("match company").className).toContain(
      "bg-rose-500/10"
    );

    fireEvent.change(screen.getByLabelText("rename company_name"), {
      target: { value: "company" },
    });

    expect(screen.getByLabelText("match company").className).toContain(
      "bg-emerald-500/10"
    );
  });
});
