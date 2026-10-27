import {
  createDashboardFormatters,
  type DashboardFormatters,
} from "@/components/dashboard/dashboard-formatters";

/** Kazakh percent spacing differs between browser and server ICU versions.
 * Keep its space/comma number conventions stable through Russian formatting.
 * This applies only to landing numbers. */
export function createLandingNumberFormatters(
  locale: string
): Pick<
  DashboardFormatters,
  "integer" | "signedPercent" | "currency" | "percent"
> {
  return createDashboardFormatters(locale === "kz" ? "ru-RU" : locale);
}
