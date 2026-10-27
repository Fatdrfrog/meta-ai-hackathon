/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RevenuePlaybookDialog } from "./revenue-playbook-dialog";
import {
  buildRevenuePlaybookSeed,
  type RevenuePlaybookConfig,
} from "./scenario-revenue-playbooks";

const mockTemplates = jest.fn();
jest.mock("@/lib/scenarios/client", () => ({
  fetchScenarioWhatsAppTemplates: (...args: unknown[]) =>
    mockTemplates(...args),
}));
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    key === "defaults.bookingButtonLabel" ? "Book" : key,
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("@/components/campaigns/campaign-recipient-picker", () => ({
  CampaignRecipientPicker: ({
    onRecipientsChange,
    disabled,
  }: {
    onRecipientsChange: (value: { phone: string }[]) => void;
    disabled: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onRecipientsChange([{ phone: "+77001234567" }])}
    >
      Add recipient
    </button>
  ),
}));

const template = {
  id: "template-1",
  name: "offer",
  language: "en",
  status: "APPROVED",
  components: [
    { type: "BODY", text: "Welcome back" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Interested" },
        { type: "QUICK_REPLY", text: "No thanks" },
      ],
    },
  ],
};
const sources = [
  { id: "11111111-1111-4111-8111-111111111111", label: "Shop" },
  { id: "22222222-2222-4222-8222-222222222222", label: "Clinic" },
];
const props = () => ({
  workspaceId: "workspace",
  open: true,
  onOpenChange: jest.fn(),
  isCreating: false,
  sourceOptions: sources,
  onCreate: jest.fn(async (config: RevenuePlaybookConfig) => {
    buildRevenuePlaybookSeed(config);
    return true;
  }),
});
function choose(goal: string) {
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`goals.${goal}.title`) })
  );
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(`fields.${label}`), {
    target: { value },
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockTemplates.mockResolvedValue([template]);
});

it("creates an editable ad consultation from fixed text and a booking URL", async () => {
  const input = props();
  render(<RevenuePlaybookDialog {...input} />);
  expect(screen.queryByLabelText("fields.sourceId")).not.toBeInTheDocument();
  change("bookingUrl", "https://example.com/book");
  fireEvent.click(screen.getByRole("button", { name: "createDraft" }));
  await waitFor(() =>
    expect(input.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "ad_consultation",
        bookingUrl: "https://example.com/book",
        openingText: expect.any(String),
        qualificationQuestion: expect.any(String),
      })
    )
  );
  expect(input.onCreate.mock.calls[0][0]).not.toHaveProperty("sourceId");
  expect(mockTemplates).not.toHaveBeenCalled();
});

it("uses a keyword trigger for unpaid recovery without pretending a payment API exists", async () => {
  const input = props();
  render(<RevenuePlaybookDialog {...input} />);
  expect(
    screen.queryByLabelText("fields.triggerKeyword")
  ).not.toBeInTheDocument();
  choose("unpaid_recovery");
  expect(screen.getByLabelText("fields.triggerKeyword")).toBeInTheDocument();
  change("triggerKeyword", "invoice");
  fireEvent.click(screen.getByRole("button", { name: "createDraft" }));
  await waitFor(() =>
    expect(input.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "unpaid_recovery",
        triggerKeyword: "invoice",
      })
    )
  );
});

it("requires an explicit bulk audience and chosen positive quick-reply button", async () => {
  const input = props();
  render(<RevenuePlaybookDialog {...input} />);
  choose("repeat_purchase");
  change("sourceId", sources[0].id);
  await screen.findByRole("option", { name: "offer · en" });
  change("template", "template-1");
  change("templateReplyButtonIndex", "0");
  fireEvent.click(screen.getByRole("button", { name: "createDraft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "validation.required"
  );
  fireEvent.click(screen.getByRole("button", { name: "Add recipient" }));
  fireEvent.click(screen.getByRole("button", { name: "createDraft" }));
  await waitFor(() =>
    expect(input.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: sources[0].id,
        recipients: ["+77001234567"],
        template,
        templateReplyButtonIndex: 0,
      })
    )
  );
  expect(mockTemplates).toHaveBeenCalledWith("workspace", {
    sourceId: sources[0].id,
    force: false,
    throwOnError: true,
  });
  expect(screen.getByText("selectedReplyHelp")).toBeInTheDocument();
});

it("keeps old-source template responses out of the selected source", async () => {
  let finishOld!: (value: (typeof template)[]) => void;
  mockTemplates
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve;
        })
    )
    .mockResolvedValueOnce([
      { ...template, id: "clinic-template", name: "clinic" },
    ]);
  render(<RevenuePlaybookDialog {...props()} />);
  choose("repeat_purchase");
  change("sourceId", sources[0].id);
  expect(screen.getByRole("status")).toHaveTextContent("templatesLoading");
  change("sourceId", sources[1].id);
  await screen.findByRole("option", { name: "clinic · en" });
  await act(async () => finishOld([template]));
  expect(
    screen.queryByRole("option", { name: "offer · en" })
  ).not.toBeInTheDocument();
});

it("shows catalog errors and retries instead of presenting failure as no templates", async () => {
  mockTemplates.mockRejectedValueOnce(new Error("unavailable"));
  render(<RevenuePlaybookDialog {...props()} />);
  choose("repeat_purchase");
  change("sourceId", sources[0].id);
  expect(await screen.findByRole("alert")).toHaveTextContent("templatesError");
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  await screen.findByRole("option", { name: "offer · en" });
  expect(mockTemplates).toHaveBeenLastCalledWith("workspace", {
    sourceId: sources[0].id,
    force: true,
    throwOnError: true,
  });
});

it("resets source, template and recipient state when the workspace changes", async () => {
  const input = props();
  const view = render(<RevenuePlaybookDialog {...input} />);
  choose("repeat_purchase");
  change("sourceId", sources[0].id);
  await screen.findByRole("option", { name: "offer · en" });
  view.rerender(
    <RevenuePlaybookDialog {...input} workspaceId="other-workspace" />
  );
  expect(screen.queryByLabelText("fields.sourceId")).not.toBeInTheDocument();
  expect(screen.getByLabelText("fields.bookingUrl")).toHaveValue("");
});

it("retains the form and offers retry after creation fails", async () => {
  const input = props();
  input.onCreate.mockResolvedValue(false);
  render(<RevenuePlaybookDialog {...input} />);
  choose("unpaid_recovery");
  change("triggerKeyword", "invoice");
  fireEvent.click(screen.getByRole("button", { name: "createDraft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("createError");
  expect(screen.getByLabelText("fields.triggerKeyword")).toHaveValue("invoice");
});

it("disables edits and duplicate submits while creation is pending", async () => {
  const input = props();
  input.onCreate.mockImplementation(() => new Promise(() => {}));
  render(<RevenuePlaybookDialog {...input} />);
  choose("unpaid_recovery");
  change("triggerKeyword", "invoice");
  fireEvent.click(screen.getByRole("button", { name: "createDraft" }));
  expect(
    await screen.findByRole("button", { name: "creating" })
  ).toBeDisabled();
  expect(screen.getByLabelText("fields.name")).toBeDisabled();
  expect(input.onCreate).toHaveBeenCalledTimes(1);
});
