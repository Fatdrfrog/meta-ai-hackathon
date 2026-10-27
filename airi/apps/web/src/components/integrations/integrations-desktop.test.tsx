/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntegrationsDesktop } from "./integrations-desktop";

let searchParams = new URLSearchParams("utm=keep");

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => searchParams,
}));

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light" }),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, src }: { alt: string; src: string | { src: string } }) => (
    // eslint-disable-next-line @next/next/no-img-element -- This is the Next Image test double.
    <img alt={alt} src={typeof src === "string" ? src : src.src} />
  ),
}));

jest.mock("./integration-registry", () => ({
  INTEGRATIONS: [
    {
      id: "whatsapp",
      category: "channel",
      icon: {
        light: { src: "/whatsapp.svg" },
        dark: { src: "/whatsapp.svg" },
      },
    },
    {
      id: "email",
      category: "channel",
      icon: {
        light: { src: "/email.svg" },
        dark: { src: "/email.svg" },
      },
    },
  ],
}));

describe("IntegrationsDesktop", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("utm=keep");
    window.history.replaceState(
      null,
      "",
      "/panel/w/workspace-1/settings/integrations?utm=keep"
    );
  });

  it("selects a source with native history and shows a pending visual state", () => {
    const onSelectIntegration = jest.fn();

    const { rerender } = render(
      <IntegrationsDesktop
        sources={[]}
        emailIntegrationEnabled={true}
        emailProviderStatus="disconnected"
        activeType={null}
        selectedIntegrationId={null}
        pendingIntegrationId="whatsapp"
        onSelectIntegration={onSelectIntegration}
      />
    );

    const sourceButton = screen.getByRole("button", {
      name: /whatsapp\.name/,
    });
    fireEvent.click(sourceButton);
    expect(onSelectIntegration).toHaveBeenCalledWith("whatsapp");

    expect(sourceButton.closest(".bg-background")).toHaveClass(
      "flex",
      "flex-col"
    );
    expect(sourceButton.closest(".bg-background")).not.toHaveClass(
      "border",
      "shadow-sm",
      "xl:h-full"
    );
    expect(sourceButton).toHaveClass("min-h-14", "rounded-md");
    expect(sourceButton).not.toHaveClass("border");
    expect(screen.queryByText("whatsapp.description")).not.toBeInTheDocument();
    expect(sourceButton).toHaveAttribute("aria-busy", "true");

    rerender(
      <IntegrationsDesktop
        sources={[]}
        emailIntegrationEnabled={true}
        emailProviderStatus="disconnected"
        selectedIntegrationId="whatsapp"
        activeType={null}
        pendingIntegrationId={null}
        onSelectIntegration={onSelectIntegration}
      />
    );
    expect(sourceButton).not.toHaveAttribute("aria-busy");
  });

  it("keeps controlled empty filters and selection empty when the route is stale", () => {
    searchParams = new URLSearchParams(
      "type=whatsapp&integration=whatsapp&utm=keep"
    );

    render(
      <IntegrationsDesktop
        sources={[]}
        emailIntegrationEnabled={true}
        emailProviderStatus="disconnected"
        activeType={null}
        selectedIntegrationId={null}
        pendingIntegrationId={null}
        onSelectIntegration={jest.fn()}
      />
    );

    const whatsappButton = screen.getByRole("button", {
      name: /whatsapp\.name/,
    });

    expect(
      screen.getByRole("button", { name: /email\.name/ })
    ).toBeInTheDocument();
    expect(whatsappButton).toHaveAttribute("aria-pressed", "false");
    expect(whatsappButton.closest(".bg-background")).not.toHaveClass("hidden");
  });

  it("renders the pending state supplied by the workspace owner", () => {
    render(
      <IntegrationsDesktop
        sources={[]}
        emailIntegrationEnabled={true}
        emailProviderStatus="disconnected"
        activeType={null}
        selectedIntegrationId={null}
        pendingIntegrationId="whatsapp"
        onSelectIntegration={jest.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: /whatsapp\.name/ })
    ).toHaveAttribute("aria-busy", "true");
  });

  it("renders a dense landing presentation without row descriptions, status text, or icon chrome", () => {
    render(
      <IntegrationsDesktop
        sources={[]}
        emailIntegrationEnabled={true}
        emailProviderStatus="disconnected"
        activeType={null}
        selectedIntegrationId={null}
        pendingIntegrationId={null}
        onSelectIntegration={jest.fn()}
        presentation="landingCompact"
      />
    );

    const sourceLink = screen.getByRole("link", { name: /whatsapp\.name/ });

    expect(sourceLink).toHaveAttribute(
      "href",
      "/?utm=keep&integration=whatsapp#integrations"
    );
    expect(sourceLink).toHaveClass("min-h-10", "max-w-[9.5rem]");
    expect(sourceLink).not.toHaveClass("border");
    expect(screen.queryByText("categories.channel")).not.toBeInTheDocument();
    expect(screen.queryByText("whatsapp.description")).not.toBeInTheDocument();
    expect(screen.queryByText("status.disconnected")).not.toBeInTheDocument();
    expect(sourceLink.querySelector(".rounded-full")).toBeNull();
    expect(screen.getByTestId("integration-list-icon-whatsapp")).toHaveClass(
      "bg-transparent"
    );
  });

  it("uses compact links as progressive selection controls", () => {
    const onSelectIntegration = jest.fn();

    render(
      <IntegrationsDesktop
        sources={[]}
        emailIntegrationEnabled={true}
        emailProviderStatus="disconnected"
        activeType={null}
        selectedIntegrationId={null}
        pendingIntegrationId={null}
        presentation="landingCompact"
        onSelectIntegration={onSelectIntegration}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: /whatsapp\.name/ }));

    expect(onSelectIntegration).toHaveBeenCalledWith("whatsapp");
  });

  it("exposes disabled compact links and prevents keyboard activation", async () => {
    const user = userEvent.setup();
    const onSelectIntegration = jest.fn();

    render(
      <IntegrationsDesktop
        sources={[]}
        emailIntegrationEnabled={false}
        emailProviderStatus="disconnected"
        activeType={null}
        selectedIntegrationId={null}
        pendingIntegrationId={null}
        presentation="landingCompact"
        onSelectIntegration={onSelectIntegration}
      />
    );

    const emailLink = screen.getByRole("link", { name: /email\.name/ });
    emailLink.focus();
    await user.keyboard("{Enter}");

    expect(emailLink).toHaveAttribute("aria-disabled", "true");
    expect(emailLink).toHaveFocus();
    expect(onSelectIntegration).not.toHaveBeenCalled();
  });
});
