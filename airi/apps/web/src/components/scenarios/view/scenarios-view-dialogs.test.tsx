/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";

const mockLoadedDialogs: string[] = [];

function mockDialogModule(name: string, exportName: string) {
  mockLoadedDialogs.push(name);
  return {
    [exportName]: ({ open }: { open: boolean }) => (
      <div data-testid={name} data-open={String(open)} />
    ),
  };
}

jest.mock("./scenario-create-type-dialog", () =>
  mockDialogModule("create-type", "ScenarioCreateTypeDialog")
);
jest.mock("./whatsapp-linked-flow-preview-dialog", () =>
  mockDialogModule("linked-flow", "WhatsAppLinkedFlowPreviewDialog")
);
jest.mock("./preview/drawer", () =>
  mockDialogModule("preview-drawer", "ScenarioPreviewDrawer")
);
jest.mock("./scenario-activation-impact-dialog", () =>
  mockDialogModule("activation-impact", "ScenarioActivationImpactDialog")
);
jest.mock("./scenarios-view-shell", () => ({
  ScenarioPendingConfirmationDialog: () => null,
}));

import { ScenariosViewDialogs } from "./scenarios-view-dialogs";

type DialogsProps = ComponentProps<typeof ScenariosViewDialogs>;

function dialogsProps(
  open: Partial<
    Record<
      | "createTypeDialog"
      | "linkedFlowPreviewDialog"
      | "previewDrawer"
      | "activationImpactDialog",
      boolean
    >
  > = {}
): DialogsProps {
  const dialog = (key: keyof typeof open) => ({
    open: open[key] ?? false,
    onOpenChange: jest.fn(),
  });
  return {
    createTypeDialog: dialog("createTypeDialog"),
    linkedFlowPreviewDialog: dialog("linkedFlowPreviewDialog"),
    previewDrawer: dialog("previewDrawer"),
    activationImpactDialog: dialog("activationImpactDialog"),
    airiCreateDialog: { open: false },
    revenuePlaybookDialog: { open: false },
    pendingConfirmationDialog: {},
  } as unknown as DialogsProps;
}

describe("ScenariosViewDialogs", () => {
  beforeEach(() => {
    mockLoadedDialogs.length = 0;
  });

  it("downloads no dialog until it opens, and keeps it mounted after closing", async () => {
    const view = render(<ScenariosViewDialogs {...dialogsProps()} />);
    await act(async () => undefined);
    expect(mockLoadedDialogs).toEqual([]);
    expect(screen.queryByTestId("create-type")).toBeNull();

    view.rerender(
      <ScenariosViewDialogs {...dialogsProps({ createTypeDialog: true })} />
    );
    const createType = await screen.findByTestId("create-type");
    expect(createType.dataset.open).toBe("true");
    expect(mockLoadedDialogs).toEqual(["create-type"]);

    // Closing keeps the dialog mounted so its close animation can run.
    view.rerender(<ScenariosViewDialogs {...dialogsProps()} />);
    expect(screen.getByTestId("create-type").dataset.open).toBe("false");
  });

  it("opens the preview drawer on load when the page asks for it", async () => {
    render(<ScenariosViewDialogs {...dialogsProps({ previewDrawer: true })} />);

    const drawer = await screen.findByTestId("preview-drawer");
    expect(drawer.dataset.open).toBe("true");
    expect(mockLoadedDialogs).toEqual(["preview-drawer"]);
  });

  it.each([
    ["linkedFlowPreviewDialog", "linked-flow"],
    ["activationImpactDialog", "activation-impact"],
  ] as const)("mounts %s on its first open", async (key, testId) => {
    const view = render(<ScenariosViewDialogs {...dialogsProps()} />);
    expect(screen.queryByTestId(testId)).toBeNull();

    view.rerender(<ScenariosViewDialogs {...dialogsProps({ [key]: true })} />);
    expect((await screen.findByTestId(testId)).dataset.open).toBe("true");
  });

  it("renders no dialog on the server, even one the page opens on load", () => {
    const html = renderToString(
      <ScenariosViewDialogs
        {...dialogsProps({ previewDrawer: true, createTypeDialog: true })}
      />
    );
    expect(html).not.toContain("data-testid");
  });
});
