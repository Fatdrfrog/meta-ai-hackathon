/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";

import { WhatsAppQrArtwork } from "./whatsapp-qr-artwork";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    alt,
    unoptimized: _unoptimized,
    ...props
  }: ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt || ""} {...props} />
  ),
}));

describe("WhatsAppQrArtwork loading", () => {
  it("uses a quiet fixed-size placeholder and fades artwork in after load", () => {
    const { container } = render(
      <WhatsAppQrArtwork
        workspaceId="workspace-1"
        codeId="code-1"
        placementName="Counter"
      />
    );

    const placeholder = container.querySelector(
      '[data-testid="whatsapp-qr-artwork-placeholder"]'
    );
    const image = screen.getByRole("img");
    expect(placeholder).not.toBeNull();
    expect(placeholder?.className).not.toContain("animate-pulse");
    expect(image.className).toContain("opacity-0");

    fireEvent.load(image);

    expect(
      container.querySelector('[data-testid="whatsapp-qr-artwork-placeholder"]')
    ).toBeNull();
    expect(image.className).toContain("opacity-100");
  });

  it("replaces failed artwork with the unavailable fallback", () => {
    render(
      <WhatsAppQrArtwork
        workspaceId="workspace-1"
        codeId="code-1"
        placementName="Counter"
      />
    );

    fireEvent.error(screen.getByRole("img"));

    expect(screen.getByLabelText("artworkUnavailable")).not.toBeNull();
  });
});
