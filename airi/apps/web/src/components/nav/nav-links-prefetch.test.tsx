/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { NavMain } from "./nav-main";
import { NavSecondary } from "./nav-secondary";

const mockPrefetchByHref = new Map<string, unknown>();

jest.mock("next/link", () => {
  const actual = jest.requireActual("next/link");
  const ActualLink = actual.default as typeof import("next/link").default;
  function RecordingLink(props: ComponentProps<typeof ActualLink>) {
    mockPrefetchByHref.set(String(props.href), props.prefetch);
    return <ActualLink {...props} />;
  }
  return { __esModule: true, ...actual, default: RecordingLink };
});

jest.mock("@/components/ui/sidebar", () => {
  const Pass = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    SidebarGroup: Pass,
    SidebarGroupContent: Pass,
    SidebarGroupLabel: Pass,
    SidebarMenu: Pass,
    SidebarMenuItem: Pass,
    SidebarMenuButton: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  };
});

function Icon() {
  return null;
}

const mainItems = [
  { title: "Scenarios", url: "/panel/w/workspace-1/scenarios", icon: Icon },
  { title: "Leads", url: "/panel/w/workspace-1/leads", icon: Icon },
];
const widgetItems = [
  {
    title: "Branding",
    url: "/panel/w/workspace-1/widget-branding",
    icon: Icon,
    prefetch: false,
  },
];

describe("panel navigation prefetch", () => {
  beforeEach(() => {
    mockPrefetchByHref.clear();
  });

  it("prefetches a section only once the user points at or focuses it", () => {
    render(
      <>
        <NavMain items={mainItems} pathname="/panel/w/workspace-1/kb" />
        <NavSecondary
          items={widgetItems}
          pathname="/panel/w/workspace-1/kb"
          className=""
        />
      </>
    );

    expect(Object.fromEntries(mockPrefetchByHref)).toEqual({
      "/panel/w/workspace-1/scenarios": false,
      "/panel/w/workspace-1/leads": false,
      "/panel/w/workspace-1/widget-branding": false,
    });

    fireEvent.mouseEnter(screen.getByRole("link", { name: "Scenarios" }));
    fireEvent.focus(screen.getByRole("link", { name: "Branding" }));

    expect(Object.fromEntries(mockPrefetchByHref)).toEqual({
      "/panel/w/workspace-1/scenarios": null,
      "/panel/w/workspace-1/leads": false,
      "/panel/w/workspace-1/widget-branding": false,
    });
  });
});
