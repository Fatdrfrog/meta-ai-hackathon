/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { installTranslatedDomGuards } from "./benign-browser-errors";

// What Chrome's page translator does: every text node is swapped for
// <font><font>translated</font></font>, detaching the node React holds.
function translatePage(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const text of textNodes) {
    const outer = document.createElement("font");
    const inner = document.createElement("font");
    inner.textContent = `ru:${text.data}`;
    outer.append(inner);
    text.replaceWith(outer);
  }
}

class CrashRecorder extends Component<
  { onCrash: (error: Error) => void; children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onCrash(error);
  }

  render() {
    return this.state.crashed ? <p>crashed</p> : this.props.children;
  }
}

function SavingStatus({ saving }: { saving: boolean }) {
  return (
    <p>
      {saving && "Saving"}
      <span>Saved tags</span>
    </p>
  );
}

function ChannelLabel({ showBadge }: { showBadge: boolean }) {
  return (
    <p>
      {showBadge && <b>New</b>}
      {"WhatsApp"}
    </p>
  );
}

function renderTranslated(first: ReactNode, next: ReactNode) {
  const crashes: Error[] = [];
  const onCrash = (error: Error) => crashes.push(error);
  const view = render(<CrashRecorder onCrash={onCrash}>{first}</CrashRecorder>);
  translatePage(view.container);
  view.rerender(<CrashRecorder onCrash={onCrash}>{next}</CrashRecorder>);
  return { crashes, container: view.container };
}

describe("installTranslatedDomGuards", () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // Ordered: the first test proves the crash before the guards go in, because
  // they patch Node.prototype for the rest of this file.
  it("reproduces the translated-page crash without the guards", () => {
    const removal = renderTranslated(
      <SavingStatus saving />,
      <SavingStatus saving={false} />
    );
    expect(removal.crashes.map(error => error.name)).toEqual(["NotFoundError"]);

    const insertion = renderTranslated(
      <ChannelLabel showBadge={false} />,
      <ChannelLabel showBadge />
    );
    expect(insertion.crashes.map(error => error.name)).toEqual([
      "NotFoundError",
    ]);
  });

  it("keeps rendering when React removes text a translator replaced", () => {
    installTranslatedDomGuards();

    const { crashes, container } = renderTranslated(
      <SavingStatus saving />,
      <SavingStatus saving={false} />
    );

    expect(crashes).toEqual([]);
    expect(container.querySelector("span")).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps rendering when React inserts before text a translator replaced", () => {
    installTranslatedDomGuards();

    const { crashes, container } = renderTranslated(
      <ChannelLabel showBadge={false} />,
      <ChannelLabel showBadge />
    );

    expect(crashes).toEqual([]);
    expect(container.querySelector("b")?.textContent).toBe("New");
  });

  it("removes a moved node from where it now lives", () => {
    installTranslatedDomGuards();
    const parent = document.createElement("div");
    const wrapper = document.createElement("font");
    const child = document.createTextNode("Saving");
    parent.append(wrapper);
    wrapper.append(child);

    expect(parent.removeChild(child)).toBe(child);
    expect(child.parentNode).toBeNull();
  });

  it("leaves ordinary DOM calls unchanged", () => {
    installTranslatedDomGuards();
    const removeChild = Node.prototype.removeChild;
    installTranslatedDomGuards();
    expect(Node.prototype.removeChild).toBe(removeChild);

    const parent = document.createElement("div");
    const first = document.createElement("i");
    const second = document.createElement("b");
    parent.append(second);
    parent.insertBefore(first, second);
    expect(Array.from(parent.children)).toEqual([first, second]);

    parent.removeChild(first);
    expect(Array.from(parent.children)).toEqual([second]);
    expect(() => parent.removeChild(null as unknown as Node)).toThrow(
      TypeError
    );
  });
});
