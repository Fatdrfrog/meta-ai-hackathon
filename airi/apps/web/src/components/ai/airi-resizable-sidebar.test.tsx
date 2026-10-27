/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AiriResizableSidebar } from "./airi-resizable-sidebar";

describe("AiriResizableSidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  it("keeps the draft open when keyboard focus moves outside the nonmodal sidebar", async () => {
    const onOpenChange = jest.fn();
    render(
      <>
        <button type="button">Outside control</button>
        <AiriResizableSidebar
          open
          onOpenChange={onOpenChange}
          title="Airi"
          description="Embedded assistant"
          storageKey="airi-focus-width"
        >
          <textarea aria-label="Draft" defaultValue="@" />
          <button type="button" disabled>
            Send
          </button>
        </AiriResizableSidebar>
      </>
    );
    const draft = await screen.findByRole("textbox", { name: "Draft" });
    const outside = screen.getByRole("button", { name: "Outside control" });
    act(() => draft.focus());
    act(() => outside.focus());
    expect(outside).toHaveFocus();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(draft).toHaveValue("@");
    expect(screen.getByRole("dialog", { name: "Airi" })).toBeInTheDocument();
  });

  it.each(["Escape", "outside pointer"])(
    "still dismisses on %s",
    async action => {
      const onOpenChange = jest.fn();
      render(
        <>
          <button type="button">Outside control</button>
          <AiriResizableSidebar
            open
            onOpenChange={onOpenChange}
            title="Airi"
            description="Embedded assistant"
            storageKey="airi-dismiss-width"
          >
            <textarea aria-label="Draft" />
          </AiriResizableSidebar>
        </>
      );
      await screen.findByRole("dialog", { name: "Airi" });
      // Radix installs its outside-pointer listener on the next task.
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      if (action === "Escape") {
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft" }), {
          key: "Escape",
        });
      } else {
        fireEvent.pointerDown(
          screen.getByRole("button", { name: "Outside control" })
        );
      }
      expect(onOpenChange).toHaveBeenCalledWith(false);
    }
  );

  it("restores persisted desktop width and supports keyboard resizing", async () => {
    const onOpenChange = jest.fn();
    window.localStorage.setItem("airi-test-width", "612");

    render(
      <AiriResizableSidebar
        open
        onOpenChange={onOpenChange}
        title="Airi"
        description="Embedded assistant"
        storageKey="airi-test-width"
      >
        <div>Sidebar content</div>
      </AiriResizableSidebar>
    );

    const dialog = await screen.findByRole("dialog", { name: "Airi" });
    await waitFor(() =>
      expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe(
        "612px"
      )
    );
    expect(window.localStorage.getItem("airi-test-width")).toBe("612");
    expect(dialog).toHaveClass(
      "w-screen",
      "sm:w-[var(--airi-sidebar-width)]",
      "max-w-full",
      "motion-reduce:animate-none"
    );
    expect(
      screen.getAllByRole("button", { name: "Close Airi sidebar" })
    ).toHaveLength(1);

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize Airi sidebar" }),
      { key: "ArrowLeft" }
    );

    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("628px");
    await waitFor(() =>
      expect(window.localStorage.getItem("airi-test-width")).toBe("628")
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Airi sidebar" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses the full mobile viewport without overwriting desktop width", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    window.localStorage.setItem("airi-mobile-width", "612");

    render(
      <AiriResizableSidebar
        open
        onOpenChange={jest.fn()}
        title="Airi"
        description="Embedded assistant"
        storageKey="airi-mobile-width"
      >
        <div>Sidebar content</div>
      </AiriResizableSidebar>
    );

    const dialog = await screen.findByRole("dialog", { name: "Airi" });
    expect(dialog).toHaveClass("w-screen", "sm:w-[var(--airi-sidebar-width)]");
    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("612px");
    await waitFor(() =>
      expect(window.localStorage.getItem("airi-mobile-width")).toBe("612")
    );
  });

  it("ends pointer resizing when the pointer is cancelled", async () => {
    render(
      <AiriResizableSidebar
        open
        onOpenChange={jest.fn()}
        title="Airi"
        description="Embedded assistant"
        storageKey="airi-pointer-cancel-width"
        defaultWidth={440}
      >
        <div>Sidebar content</div>
      </AiriResizableSidebar>
    );

    const dialog = await screen.findByRole("dialog", { name: "Airi" });
    const separator = screen.getByRole("separator", {
      name: "Resize Airi sidebar",
    });
    fireEvent(
      separator,
      new MouseEvent("pointerdown", { bubbles: true, clientX: 600 })
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 550 })
    );
    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("490px");

    fireEvent.pointerCancel(window);
    fireEvent.pointerCancel(window);
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 500 })
    );

    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("490px");
  });

  it("ends pointer resizing when the window loses focus", async () => {
    render(
      <AiriResizableSidebar
        open
        onOpenChange={jest.fn()}
        title="Airi"
        description="Embedded assistant"
        storageKey="airi-blur-width"
        defaultWidth={440}
      >
        <div>Sidebar content</div>
      </AiriResizableSidebar>
    );

    const dialog = await screen.findByRole("dialog", { name: "Airi" });
    const separator = screen.getByRole("separator", {
      name: "Resize Airi sidebar",
    });
    fireEvent(
      separator,
      new MouseEvent("pointerdown", { bubbles: true, clientX: 600 })
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 550 })
    );
    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("490px");

    fireEvent.blur(window);
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 500 })
    );

    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("490px");
  });

  it("ends pointer resizing when the controlled sidebar closes", async () => {
    const sidebar = (open: boolean) => (
      <AiriResizableSidebar
        open={open}
        onOpenChange={jest.fn()}
        title="Airi"
        description="Embedded assistant"
        storageKey="airi-close-width"
        defaultWidth={440}
      >
        <div>Sidebar content</div>
      </AiriResizableSidebar>
    );
    const view = render(sidebar(true));

    let dialog = await screen.findByRole("dialog", { name: "Airi" });
    fireEvent(
      screen.getByRole("separator", { name: "Resize Airi sidebar" }),
      new MouseEvent("pointerdown", { bubbles: true, clientX: 600 })
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 550 })
    );
    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("490px");

    view.rerender(sidebar(false));
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 500 })
    );
    view.rerender(sidebar(true));

    dialog = await screen.findByRole("dialog", { name: "Airi" });
    expect(dialog.style.getPropertyValue("--airi-sidebar-width")).toBe("490px");
  });
});
