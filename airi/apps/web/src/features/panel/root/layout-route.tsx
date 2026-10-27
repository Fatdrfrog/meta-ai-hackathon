import { AppUpdateBanner } from "@/components/app-update-banner";
import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import {
  getLocaleFromCookie,
  loadPanelClientMessages,
} from "@/i18n/message-loader";
import { getAppVersion } from "@/lib/app-version";
import { AuthProvider } from "@/lib/auth/auth-context";
import { Suspense, type ReactNode } from "react";
import PanelLoadingView from "./loading-view";

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<PanelLoadingView />}>
      <PanelLayoutContent>{children}</PanelLayoutContent>
    </Suspense>
  );
}

async function PanelLayoutContent({ children }: { children: ReactNode }) {
  const appVersion = getAppVersion();
  const locale = await getLocaleFromCookie();
  const messages = await loadPanelClientMessages(locale);

  return (
    <ScopedIntlProvider messages={messages}>
      <AuthProvider>
        <AppUpdateBanner currentVersion={appVersion.version} />
        {children}
      </AuthProvider>
    </ScopedIntlProvider>
  );
}
