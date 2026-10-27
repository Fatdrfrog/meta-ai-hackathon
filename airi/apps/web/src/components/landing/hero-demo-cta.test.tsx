/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HeroDemoCta } from "./hero-demo-cta";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const messages: Record<string, string> = {
      workEmail: "Work email",
      bookDemo: "Book a demo",
      invalidEmail: "Enter a valid work email",
      demoSuccess: "Thanks! We'll be in touch soon.",
      demoError: "Something went wrong. Please try again.",
    };
    return messages[key] ?? key;
  },
}));

describe("HeroDemoCta", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("validates email with zod before calling the API", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<HeroDemoCta />);

    fireEvent.change(screen.getByPlaceholderText("Work email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: /book a demo/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid work email"
    );
    const email = screen.getByRole("textbox", { name: "Work email" });
    expect(email).toHaveFocus();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Enter a valid work email");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a valid email to the demo-request API", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<HeroDemoCta />);

    fireEvent.change(screen.getByPlaceholderText("Work email"), {
      target: { value: "sam@company.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /book a demo/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/landing/demo-request",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            email: "sam@company.com",
            website: "",
          }),
        })
      );
    });

    expect(
      await screen.findByText("Thanks! We'll be in touch soon.")
    ).toBeInTheDocument();
  });
  it("keeps the submit button named and marks it busy while submitting", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as typeof fetch;
    render(<HeroDemoCta />);
    fireEvent.change(screen.getByRole("textbox", { name: "Work email" }), {
      target: { value: "sam@company.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Book a demo" }));
    const button = screen.getByRole("button", { name: "Book a demo" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("includes a visually hidden honeypot value in the request payload", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(<HeroDemoCta />);
    const honeypot = container.querySelector<HTMLInputElement>(
      'input[name="website"]'
    );
    expect(honeypot).not.toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Work email"), {
      target: { value: "sam@company.com" },
    });
    fireEvent.change(honeypot!, {
      target: { value: "https://spam.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: /book a demo/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/landing/demo-request",
        expect.objectContaining({
          body: JSON.stringify({
            email: "sam@company.com",
            website: "https://spam.example",
          }),
        })
      );
    });
  });

  it("focuses the email when a visitor explicitly reveals the demo form", () => {
    render(<HeroDemoCta focusOnMount />);
    expect(screen.getByRole("textbox", { name: "Work email" })).toHaveFocus();
  });

  it("announces a server error and preserves the email for a successful retry", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;
    render(<HeroDemoCta />);
    const email = screen.getByRole("textbox", { name: "Work email" });
    fireEvent.change(email, { target: { value: "sam@company.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Book a demo" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Something went wrong. Please try again."
      )
    );
    expect(email).toHaveValue("sam@company.com");
    expect(email).toHaveAccessibleDescription(
      "Something went wrong. Please try again."
    );
    fireEvent.click(screen.getByRole("button", { name: "Book a demo" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Thanks! We'll be in touch soon."
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
