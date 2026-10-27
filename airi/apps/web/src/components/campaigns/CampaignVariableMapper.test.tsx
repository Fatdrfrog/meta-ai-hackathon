/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { CampaignVariableSourceConfig } from "@icecore/scenario-contracts";
import { CampaignVariableMapper } from "./CampaignVariableMapper";

const mockPreviewAutoVariables = jest.fn();
jest.mock("@/lib/campaign/campaign-variable-values", () => {
  const actual = jest.requireActual("@/lib/campaign/campaign-variable-values");
  return {
    ...actual,
    previewCampaignAutoVariableValues: (
      ...args: Parameters<typeof actual.previewCampaignAutoVariableValues>
    ) => {
      mockPreviewAutoVariables(...args);
      return actual.previewCampaignAutoVariableValues(...args);
    },
  };
});

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

function renderMapper(
  recipients: Array<{ phone?: string; name?: string }>,
  variableConfigs: Record<string, CampaignVariableSourceConfig> = {}
) {
  return render(
    <CampaignVariableMapper
      recipients={recipients}
      templateVariables={["1"]}
      variableConfigs={variableConfigs}
      onVariableConfigsChange={jest.fn()}
      compact
    />
  );
}

describe("CampaignVariableMapper", () => {
  it("shows what the first recipient gets and how many nameless rows get their phone", () => {
    renderMapper([
      { phone: "+77001234567", name: "Aibek" },
      { phone: "+77001234568" },
      { phone: "+77001234569" },
    ]);

    const preview = screen.getByTestId("campaign-variable-preview-1");
    expect(preview.textContent).toContain(
      'recipient.variablePreview:{"value":"Aibek"}'
    );
    expect(preview.textContent).toContain(
      'recipient.variablePhoneFallback:{"count":2}'
    );
  });

  it("shows the phone a nameless first recipient gets", () => {
    renderMapper([{ phone: "+77001234568" }]);

    const preview = screen.getByTestId("campaign-variable-preview-1");
    expect(preview.textContent).toContain(
      'recipient.variablePreview:{"value":"+77001234568"}'
    );
    expect(preview.textContent).toContain(
      'recipient.variablePhoneFallback:{"count":1}'
    );
  });

  it("leaves out the phone count when every recipient has a name", () => {
    renderMapper([{ phone: "+77001234567", name: "Aibek" }]);

    expect(
      screen.getByTestId("campaign-variable-preview-1").textContent
    ).not.toContain("recipient.variablePhoneFallback");
  });

  it("says when the first recipient gets no value", () => {
    renderMapper([{}, { phone: "+77001234568" }]);

    expect(
      screen.getByTestId("campaign-variable-preview-1").textContent
    ).toContain("recipient.variablePreviewEmpty");
  });

  it("previews only auto mode and nothing without recipients", () => {
    const { unmount } = renderMapper([{ phone: "+77001234568" }], {
      "1": { mode: "recipient_phone" },
    });
    expect(screen.queryByTestId("campaign-variable-preview-1")).toBeNull();
    unmount();

    renderMapper([]);
    expect(screen.queryByTestId("campaign-variable-preview-1")).toBeNull();
  });

  it("doesn't rescan recipients while another variable's custom value is typed", () => {
    const recipients = [{ phone: "+77001234567", name: "Aibek" }];
    const mapper = (configs: Record<string, CampaignVariableSourceConfig>) => (
      <CampaignVariableMapper
        recipients={recipients}
        templateVariables={["1", "2"]}
        variableConfigs={configs}
        onVariableConfigsChange={jest.fn()}
        compact
      />
    );
    const { rerender } = render(
      mapper({ "2": { mode: "custom", customValue: "S" } })
    );
    mockPreviewAutoVariables.mockClear();

    rerender(mapper({ "2": { mode: "custom", customValue: "Sa" } }));
    rerender(mapper({ "2": { mode: "custom", customValue: "Sal" } }));
    expect(mockPreviewAutoVariables).not.toHaveBeenCalled();

    // Turning {{2}} to auto adds it to the scan.
    rerender(mapper({ "2": { mode: "auto" } }));
    expect(mockPreviewAutoVariables).toHaveBeenCalledTimes(1);
    expect(mockPreviewAutoVariables.mock.calls[0][0].variables).toEqual([
      "1",
      "2",
    ]);
    expect(screen.getByTestId("campaign-variable-preview-2")).toBeTruthy();
  });
});
