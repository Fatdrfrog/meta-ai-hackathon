import { SettingsNav } from "@/components/settings/settings-nav";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import SettingsLayout from "./layout-route";

const mockCanViewLimits = jest.fn();
const mockFlag = jest.fn();
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: async () => "en",
  loadSettingsClientMessages: async () => ({}),
}));
jest.mock("@/lib/limits/internal-limits-access", () => ({
  canAccessInternalLimits: (...args: unknown[]) => mockCanViewLimits(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) => mockFlag(...args),
}));
jest.mock("@/components/settings/settings-nav", () => ({
  SettingsNav: () => null,
}));
jest.mock("@/components/i18n/scoped-intl-provider", () => ({
  ScopedIntlProvider: ({ children }: { children: ReactNode }) => children,
}));

type NavItem = { title: string; group?: string; href: string };

function findNavs(node: ReactNode): ReactElement<{ items: NavItem[] }>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; items: NavItem[] }>(child)) {
      return [];
    }
    if (child.type === SettingsNav) return [child];
    return findNavs(child.props.children);
  });
}

async function renderNavItems(workspaceId = "workspace-1") {
  const layout = await SettingsLayout({
    children: null,
    params: Promise.resolve({ workspaceId }),
  });
  const navs = findNavs(layout);
  // The desktop sidebar and the mobile header show the same items.
  expect(navs).toHaveLength(2);
  expect(navs[1].props.items).toEqual(navs[0].props.items);
  return navs[0].props.items;
}

const officesHref = "/panel/w/workspace-1/settings/business-locations";

beforeEach(() => {
  jest.clearAllMocks();
  mockCanViewLimits.mockResolvedValue(false);
  mockFlag.mockResolvedValue(false);
});

it("hides Offices while scenario_location_routing is off", async () => {
  const items = await renderNavItems();
  expect(mockFlag).toHaveBeenCalledWith(
    "workspace-1",
    "scenario_location_routing"
  );
  expect(items.map(item => item.href)).not.toContain(officesHref);
});

it("shows Offices in the Workspace group right after Team when the flag is on", async () => {
  mockFlag.mockResolvedValue(true);
  const items = await renderNavItems();
  expect(items).toContainEqual({
    title: "navBusinessLocations",
    group: "groupWorkspace",
    href: officesHref,
  });
  expect(
    items
      .filter(item => item.group === "groupWorkspace")
      .map(item => item.href.split("/settings/")[1])
  ).toEqual([
    "integrations",
    "api",
    "team",
    "business-locations",
    "workspaces",
  ]);
});

it("hides Offices when the flag can't be read", async () => {
  mockFlag.mockRejectedValue(new Error("flags unavailable"));
  const items = await renderNavItems();
  expect(items.map(item => item.href)).not.toContain(officesHref);
});

it.each([
  [true, false],
  [true, true],
  [false, true],
  [false, false],
])(
  "keeps Internal limits gated on limits access (limits %s, flag %s)",
  async (canViewLimits, flag) => {
    mockCanViewLimits.mockResolvedValue(canViewLimits);
    mockFlag.mockResolvedValue(flag);
    const hrefs = (await renderNavItems()).map(item => item.href);
    expect(mockCanViewLimits).toHaveBeenCalledWith("workspace-1");
    expect(hrefs.includes("/panel/w/workspace-1/settings/limits")).toBe(
      canViewLimits
    );
    expect(hrefs.includes(officesHref)).toBe(flag);
  }
);
