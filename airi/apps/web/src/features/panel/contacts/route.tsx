import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { CustomersPage } from "@/components/customers/customers-page";
import { getReadOnlySupabaseUser } from "@/features/panel/shared/workspace";
import {
  getLocaleFromCookie,
  loadCustomersClientMessages,
} from "@/i18n/message-loader";
import { redirect } from "next/navigation";

export default async function PageContacts({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [user, { workspaceId }, locale] = await Promise.all([
    getReadOnlySupabaseUser(),
    params,
    getLocaleFromCookie(),
  ]);

  if (!user) {
    redirect("/login");
  }

  const messages = await loadCustomersClientMessages(locale);

  return (
    <ScopedIntlProvider messages={messages}>
      <div className="flex h-full flex-col overflow-hidden">
        <CustomersPage workspaceId={workspaceId} />
      </div>
    </ScopedIntlProvider>
  );
}
