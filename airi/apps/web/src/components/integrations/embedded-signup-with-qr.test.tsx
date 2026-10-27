/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("./embedded-signup-button", () => {
  const React = jest.requireActual("react") as typeof import("react");
  return {
    EmbeddedSignupButton: jest.fn(
      ({
        label,
        disabled,
        flow,
      }: {
        label: string;
        disabled?: boolean;
        flow?: string;
      }) =>
        React.createElement(
          "button",
          {
            type: "button",
            disabled,
            "data-flow": flow,
          },
          label
        )
    ),
  };
});

import { EmbeddedSignupButton } from "./embedded-signup-button";
import { EmbeddedSignupWithQR } from "./embedded-signup-with-qr";

const mockedEmbeddedSignupButton = EmbeddedSignupButton as jest.MockedFunction<
  typeof EmbeddedSignupButton
>;

describe("EmbeddedSignupWithQR", () => {
  beforeEach(() => {
    mockedEmbeddedSignupButton.mockClear();
  });

  it("uses the shared FB.login Embedded Signup button for coexistence", () => {
    render(
      <EmbeddedSignupWithQR
        workspaceId="workspace-1"
        businessName="Example Co"
        businessEmail="owner@example.com"
        businessPhone="+15550000000"
      />
    );

    expect(mockedEmbeddedSignupButton).toHaveBeenLastCalledWith(
      expect.objectContaining({
        label: "button.start",
        flow: "coexistence",
        workspaceId: "workspace-1",
        businessName: "Example Co",
        businessEmail: "owner@example.com",
        businessPhone: "+15550000000",
        disabled: true,
      }),
      undefined
    );

    fireEvent.click(screen.getByLabelText("eligibility.confirmTitle"));

    expect(mockedEmbeddedSignupButton).toHaveBeenLastCalledWith(
      expect.objectContaining({
        flow: "coexistence",
        disabled: false,
      }),
      undefined
    );

    const button = screen.getByRole("button", { name: "button.start" });
    expect(button.getAttribute("data-flow")).toBe("coexistence");
    expect(screen.getByText("title")).toBeTruthy();
  });

  it("explains why Continue is disabled and shows the eligibility guidance", () => {
    render(<EmbeddedSignupWithQR workspaceId="workspace-1" />);

    expect(screen.getByText("button.hint")).toBeTruthy();
    expect(screen.getByText("eligibility.confirmDescription")).toBeTruthy();
    expect(screen.getByText("instructions.warning")).toBeTruthy();
    expect(screen.getByText("instructions.eligibilityWarning")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("eligibility.confirmTitle"));

    expect(screen.queryByText("button.hint")).toBeNull();
  });
});
