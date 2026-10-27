/**
 * @jest-environment jsdom
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { installMatchMedia } from "@/test-support/dom-test-utils";

interface AlertDialogFixtureProps {
  actionRef?: React.Ref<HTMLButtonElement>;
  cancelRef?: React.Ref<HTMLButtonElement>;
  onOpenAutoFocus?: React.ComponentProps<
    typeof AlertDialogContent
  >["onOpenAutoFocus"];
}

function AlertDialogFixture({
  actionRef,
  cancelRef,
  onOpenAutoFocus,
}: AlertDialogFixtureProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button type="button">Open confirmation</button>
      </AlertDialogTrigger>
      <AlertDialogContent onOpenAutoFocus={onOpenAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete record?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef}>Keep record</AlertDialogCancel>
          <AlertDialogAction ref={actionRef}>Delete record</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

describe("AlertDialog", () => {
  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent,
    });
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
  });

  beforeEach(() => {
    setViewport(1024);
    installMatchMedia(() => window.innerWidth < 768);
  });

  it("preserves alert semantics, cancel focus, refs, and trigger focus on mobile", async () => {
    setViewport(375);
    const user = userEvent.setup();
    const cancelRef = React.createRef<HTMLButtonElement>();
    render(<AlertDialogFixture cancelRef={cancelRef} />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });

    await user.click(trigger);
    const content = await screen.findByRole("alertdialog", {
      name: "Delete record?",
    });
    const cancel = within(content).getByRole("button", {
      name: "Keep record",
    });

    expect(content.hasAttribute("data-vaul-drawer")).toBe(true);
    expect(cancelRef.current).toBe(cancel);
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    await user.keyboard("{Enter}");
    const animationEnd = new Event("animationend", { bubbles: true });
    Object.defineProperty(animationEnd, "animationName", {
      value: window.getComputedStyle(content).animationName,
    });
    fireEvent(content, animationEnd);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("preserves a consumer autofocus override on mobile", async () => {
    setViewport(375);
    const user = userEvent.setup();
    const actionRef = React.createRef<HTMLButtonElement>();
    const onOpenAutoFocus = jest.fn((event: Event) => {
      event.preventDefault();
      actionRef.current?.focus({ preventScroll: true });
    });
    render(
      <AlertDialogFixture
        actionRef={actionRef}
        onOpenAutoFocus={onOpenAutoFocus}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    const content = await screen.findByRole("alertdialog", {
      name: "Delete record?",
    });

    expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      within(content).getByRole("button", { name: "Delete record" })
    );
  });

  it("keeps the desktop Radix semantics and focus contract", async () => {
    const user = userEvent.setup();
    const cancelRef = React.createRef<HTMLButtonElement>();
    render(<AlertDialogFixture cancelRef={cancelRef} />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });

    await user.click(trigger);
    const content = screen.getByRole("alertdialog", {
      name: "Delete record?",
    });
    const cancel = within(content).getByRole("button", {
      name: "Keep record",
    });

    expect(content.hasAttribute("data-vaul-drawer")).toBe(false);
    expect(cancelRef.current).toBe(cancel);
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    await user.click(cancel);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
