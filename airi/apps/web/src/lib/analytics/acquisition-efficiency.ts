/** No currency conversion or cross-population efficiency is implied by this helper. */
export function comparableEfficiency(input: {
  spend: number | null;
  spendCurrency: string | null;
  revenue: number | null;
  revenueCurrency: string;
  qualified: number;
  paid: number;
  comparable: boolean;
}) {
  const valid =
    input.comparable &&
    input.spend !== null &&
    Number.isFinite(input.spend) &&
    input.spend >= 0 &&
    Boolean(input.spendCurrency);
  return {
    costPerQualified:
      valid && input.qualified > 0 ? input.spend! / input.qualified : null,
    costPerPaid: valid && input.paid > 0 ? input.spend! / input.paid : null,
    netRoas:
      valid &&
      input.spend! > 0 &&
      input.revenue !== null &&
      Number.isFinite(input.revenue) &&
      input.spendCurrency === input.revenueCurrency
        ? input.revenue / input.spend!
        : null,
  };
}
