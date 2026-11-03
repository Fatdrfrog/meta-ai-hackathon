import { productsDisplayFont } from "@/components/products/product-fonts";
import productTheme from "@/components/products/product-theme.module.css";
import { ProductsPage } from "@/components/products/products-page";
import { ErrorState } from "@/components/ui/async-states";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { productsWhatsAppNumberLabel } from "@/lib/products/whatsapp-number";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { cn } from "@/lib/utils";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import { redirect } from "next/navigation";

export default async function ProductsRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, { supabase, user }] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
  ]);

  if (!user) redirect("/login");

  // The flag is read alongside membership, but only a member learns its value.
  const [{ data: companyUser, error: accessError }, enabled] =
    await Promise.all([
      supabase
        .from("company_users")
        .select("role")
        .eq("user_id", user.id)
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
      isWorkspaceFeatureEnabled(workspaceId, "products").catch(() => false),
    ]);

  if (accessError) return <ErrorState message={PRODUCTS_COPY.loadError} />;
  if (!companyUser) redirect("/panel");
  // Redirect rather than 404, so a saved or switched-to Products path is safe.
  if (!enabled || !isCompanyAdminRole(companyUser.role)) {
    redirect(panelWorkspaceAiriHref(workspaceId));
  }

  return (
    // The Paper look and its display face, on the Products column only.
    <div
      className={cn(
        "h-full overflow-y-auto",
        productTheme.theme,
        productsDisplayFont.variable
      )}
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <ProductsPage
          key={workspaceId}
          workspaceId={workspaceId}
          whatsappNumber={productsWhatsAppNumberLabel()}
        />
      </div>
    </div>
  );
}
