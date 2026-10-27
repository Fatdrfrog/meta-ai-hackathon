import { Children, Suspense, type ReactElement, type ReactNode } from "react";
import { AppUpdateBanner } from "@/components/app-update-banner";
import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { AuthProvider } from "@/lib/auth/auth-context";
import PanelLayout from "./layout-route";
import PanelLoadingView from "./loading-view";

const mockGetLocale = jest.fn(async () => "ru");
const mockMessages = { Panel: { title: "Panel" } };
const mockLoadMessages = jest.fn(async (_locale: string) => mockMessages);

jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: () => mockGetLocale(),
  loadPanelClientMessages: (locale: string) => mockLoadMessages(locale),
}));
jest.mock("@/lib/app-version", () => ({
  getAppVersion: () => ({ version: "test-version" }),
}));
jest.mock("@/components/app-update-banner", () => ({
  AppUpdateBanner: () => null,
}));
jest.mock("@/components/i18n/scoped-intl-provider", () => ({
  ScopedIntlProvider: () => null,
}));
jest.mock("@/lib/auth/auth-context", () => ({
  AuthProvider: () => null,
}));
jest.mock("./loading-view", () => ({
  __esModule: true,
  default: () => null,
}));

it("shows a panel fallback before reading async locale data while preserving providers and children", async () => {
  const child = <div>Workspace content</div>;
  const result = PanelLayout({ children: child });

  expect(result).not.toBeInstanceOf(Promise);
  expect(mockGetLocale).not.toHaveBeenCalled();
  const boundary = result as ReactElement<{
    fallback: ReactElement;
    children: ReactElement<{ children: ReactNode }>;
  }>;
  expect(boundary.type).toBe(Suspense);
  expect(boundary.props.fallback.type).toBe(PanelLoadingView);

  const contentElement = boundary.props.children;
  const renderContent = contentElement.type as (props: {
    children: ReactNode;
  }) => Promise<ReactElement<{ messages: unknown; children: ReactElement }>>;
  const content = await renderContent(contentElement.props);

  expect(mockGetLocale).toHaveBeenCalledTimes(1);
  expect(mockLoadMessages).toHaveBeenCalledWith("ru");
  expect(content.type).toBe(ScopedIntlProvider);
  expect(content.props.messages).toBe(mockMessages);
  const auth = content.props.children as ReactElement<{ children: ReactNode }>;
  expect(auth.type).toBe(AuthProvider);
  const children = Children.toArray(auth.props.children) as ReactElement[];
  expect(children[0].type).toBe(AppUpdateBanner);
  expect(children[0].props).toEqual({ currentVersion: "test-version" });
  expect(children[1]).toMatchObject({ type: child.type, props: child.props });
});
