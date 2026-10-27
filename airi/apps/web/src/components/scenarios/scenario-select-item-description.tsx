/** Hides option descriptions in the closed Select trigger. */
export const SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS =
  "[&_[data-select-description]]:hidden";

/**
 * A Select option with a one-line explanation under its label. Give each
 * SelectItem `textValue={label}` so typeahead matches the label only, and put
 * `SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS` on the SelectTrigger.
 */
export function ScenarioSelectItemContent({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <span className="flex min-w-0 flex-col items-start">
      <span>{label}</span>
      <span
        data-select-description=""
        className="text-[10px] leading-snug text-muted-foreground"
      >
        {description}
      </span>
    </span>
  );
}
