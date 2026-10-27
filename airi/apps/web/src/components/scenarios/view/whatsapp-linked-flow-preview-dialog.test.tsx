/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { WhatsAppLinkedFlowPreviewDialog } from "./whatsapp-linked-flow-preview-dialog";

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

describe("WhatsAppLinkedFlowPreviewDialog", () => {
  it("offers the exact Meta preview as a neutral read-only state", () => {
    const props = {
      open: true,
      onOpenChange: jest.fn(),
      flowId: "flow-provider",
      flowName: "Meta appointment Flow",
      flowStatus: "PUBLISHED",
      flowConfig: null,
      loading: false,
      error: null,
      previewUrl: "https://business.facebook.com/wa/manage/flows/preview/token",
    } as ComponentProps<typeof WhatsAppLinkedFlowPreviewDialog> & {
      previewUrl: string;
    };

    render(<WhatsAppLinkedFlowPreviewDialog {...props} />);

    expect(screen.getByText("flowProviderReferenceTitle")).toBeTruthy();
    expect(screen.getByText("flowProviderReferenceDescription")).toBeTruthy();
    const previewLink = screen.getByRole("link", {
      name: "flowProviderReferencePreview",
    });
    expect(previewLink.getAttribute("href")).toBe(props.previewUrl);
    expect(previewLink.getAttribute("target")).toBe("_blank");
    expect(previewLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByText("linkedFlowPreviewUnavailable")).toBeNull();
  });

  it("keeps genuine provider failures destructive", () => {
    render(
      <WhatsAppLinkedFlowPreviewDialog
        open
        onOpenChange={jest.fn()}
        flowId="flow-provider"
        flowConfig={null}
        loading={false}
        error="Provider request failed"
      />
    );

    expect(screen.getByText("Provider request failed")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "flowProviderReferencePreview" })
    ).toBeNull();
  });
});
