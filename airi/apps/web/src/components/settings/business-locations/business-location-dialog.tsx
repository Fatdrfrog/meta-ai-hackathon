"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { TagInput } from "@/components/ui/tag-input";
import {
  toBusinessLocationInput,
  type BusinessLocationInput,
  type BusinessLocationRecord,
  type BusinessLocationsCreateResponse,
  type BusinessLocationsSaveResponse,
} from "@/lib/business-locations/types";
import {
  buildScenarioBusinessLocationKey,
  buildScenarioLocationMapsUrl,
  listScenarioBusinessLocationIssues,
  parseScenarioLocationInput,
  SCENARIO_BUSINESS_LOCATION_LIMITS,
  type ScenarioBusinessLocationIssue,
  type ScenarioLocationInput,
} from "@icecore/scenario-contracts";
import { ExternalLink, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { toast } from "sonner";
import {
  BusinessLocationsRequestError,
  businessLocationsApiUrl,
  describeBusinessLocationIssue,
  describeBusinessLocationsError,
  requestBusinessLocations,
  type BusinessLocationsTranslator,
} from "./business-locations-client";
import { CountrySelect } from "./country-select";

type FormField =
  | "name"
  | "key"
  | "country"
  | "city"
  | "address"
  | "phone"
  | "coordinates"
  | "mapUrl"
  | "tags";

/** The field each refused value belongs to; a bad sort order has none. */
const FIELD_BY_ISSUE: Record<ScenarioBusinessLocationIssue, FormField | null> =
  {
    key_invalid: "key",
    name_missing: "name",
    name_too_long: "name",
    country_invalid: "country",
    city_missing: "city",
    city_too_long: "city",
    address_too_long: "address",
    phone_too_long: "phone",
    map_url_invalid: "mapUrl",
    tags_invalid: "tags",
    tags_too_many: "tags",
    tag_too_long: "tags",
    latitude_invalid: "coordinates",
    longitude_invalid: "coordinates",
    coordinates_zero: "coordinates",
    sort_order_invalid: null,
  };

type FormState = {
  name: string;
  key: string;
  /** False while the key of a new office still follows country, city and name. */
  keyEdited: boolean;
  country: string;
  city: string;
  address: string;
  phone: string;
  coordinates: string;
  mapUrl: string;
  tags: string[];
  isActive: boolean;
};

type FieldErrors = Partial<Record<FormField, string[]>>;

/** The country most offices are in, so a new office starts there. */
function mostCommonCountry(offices: readonly BusinessLocationRecord[]): string {
  const counts = new Map<string, number>();
  let best = "";
  for (const office of offices) {
    const count = (counts.get(office.country) ?? 0) + 1;
    counts.set(office.country, count);
    if (count > (counts.get(best) ?? 0)) best = office.country;
  }
  return best;
}

function initialForm(
  office: BusinessLocationRecord | null,
  existing: readonly BusinessLocationRecord[]
): FormState {
  if (!office) {
    return {
      name: "",
      key: "",
      keyEdited: false,
      country: mostCommonCountry(existing),
      city: "",
      address: "",
      phone: "",
      coordinates: "",
      mapUrl: "",
      tags: [],
      isActive: true,
    };
  }
  return {
    name: office.name,
    key: office.key,
    keyEdited: true,
    country: office.country,
    city: office.city,
    address: office.address ?? "",
    phone: office.phone ?? "",
    coordinates: `${office.latitude}, ${office.longitude}`,
    mapUrl: office.mapUrl ?? "",
    tags: [...office.tags],
    isActive: office.isActive,
  };
}

/** The office as it is sent; an edit keeps the stored key and sort order. */
function buildInput(
  form: FormState,
  key: string,
  location: ScenarioLocationInput,
  office: BusinessLocationRecord | null
): BusinessLocationInput {
  const point = location.status === "point" ? location.point : null;
  const address = form.address.trim();
  const phone = form.phone.trim();
  const mapUrl = form.mapUrl.trim();
  const fields = {
    name: form.name.trim(),
    country: form.country,
    city: form.city.trim(),
    latitude: point?.latitude ?? "",
    longitude: point?.longitude ?? "",
    isActive: form.isActive,
  };
  if (office) {
    // An emptied field goes as undefined, which leaves it out and clears it.
    return toBusinessLocationInput(office, {
      ...fields,
      address: address || undefined,
      phone: phone || undefined,
      mapUrl: mapUrl || undefined,
      tags: form.tags.length > 0 ? form.tags : undefined,
    });
  }
  return {
    key: key.trim(),
    ...fields,
    ...(address ? { address } : {}),
    ...(phone ? { phone } : {}),
    ...(mapUrl ? { mapUrl } : {}),
    ...(form.tags.length > 0 ? { tags: form.tags } : {}),
  };
}

/**
 * Tags typed or pasted as "mall; vip" become separate tags, as an import
 * reads them; a tag can't hold `,` `;` or `|`.
 */
function splitTags(tags: readonly string[]): string[] {
  const split = tags
    .flatMap(tag => tag.split(/[,;|]/))
    .map(tag => tag.trim())
    .filter(Boolean);
  return [...new Set(split)];
}

/** Why the coordinates text gives no point, or null when it does. */
function describeLocation(
  t: BusinessLocationsTranslator,
  text: string,
  location: ScenarioLocationInput
): string | null {
  if (location.status === "point") return null;
  if (!text.trim()) return t("dialog.coordinatesMissing");
  if (location.status === "short_link") return t("dialog.coordinatesShortLink");
  if (location.status === "no_coordinates") {
    return t("dialog.coordinatesNoPoint");
  }
  return t("dialog.coordinatesInvalid");
}

function addError(errors: FieldErrors, field: FormField, message: string) {
  const messages = (errors[field] ??= []);
  if (!messages.includes(message)) messages.push(message);
}

/** Add or edit one office. It saves on its own and hands back the new list. */
export function BusinessLocationDialog({
  open,
  onOpenChange,
  workspaceId,
  office,
  existing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The office to edit, or null to add one. */
  office: BusinessLocationRecord | null;
  /** The catalog as loaded, so a new office can't take a used key. */
  existing: readonly BusinessLocationRecord[];
  onSaved: (offices: BusinessLocationRecord[]) => void;
}) {
  const t = useTranslations("BusinessLocationsSettings");
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // The dialog mounts afresh for each opening, so this is what opened it.
  // Radix only returns focus to a DialogTrigger, and this dialog has none.
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : document.activeElement
  );
  const [form, setForm] = useState(() => initialForm(office, existing));
  const [submitted, setSubmitted] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [saving, setSaving] = useState(false);
  const [serverIssues, setServerIssues] = useState<
    ScenarioBusinessLocationIssue[]
  >([]);
  const [keyTaken, setKeyTaken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const key =
    office || form.keyEdited
      ? form.key
      : (buildScenarioBusinessLocationKey({
          country: form.country,
          city: form.city,
          name: form.name,
        }) ?? "");
  const location = useMemo(
    () => parseScenarioLocationInput(form.coordinates),
    [form.coordinates]
  );
  const input = buildInput(form, key, location, office);
  const locationMessage = describeLocation(t, form.coordinates, location);
  const keyInUse =
    !office && existing.some(record => record.key === input.key.trim());

  // Field errors show after the first save attempt; the server's stay until
  // the next change.
  const issues = [
    ...(submitted ? listScenarioBusinessLocationIssues(input) : []),
    ...serverIssues,
  ];
  const errors: FieldErrors = {};
  // A new office has no key until its country, city and name allow one, and
  // those fields already say what is missing.
  const keyAwaitsFields =
    !office &&
    !form.keyEdited &&
    issues.some(
      issue =>
        issue === "name_missing" ||
        issue === "city_missing" ||
        issue === "country_invalid"
    );
  for (const issue of issues) {
    const field = FIELD_BY_ISSUE[issue];
    if (!field || (issue === "key_invalid" && keyAwaitsFields)) continue;
    const isMissingPoint =
      issue === "latitude_invalid" || issue === "longitude_invalid";
    addError(
      errors,
      field,
      isMissingPoint && locationMessage
        ? locationMessage
        : describeBusinessLocationIssue(t, issue)
    );
  }
  if (keyTaken || (submitted && keyInUse)) {
    addError(errors, "key", t("errors.office_key_taken"));
  }
  const otherIssues = issues.filter(issue => !FIELD_BY_ISSUE[issue]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const form = formRef.current;
    const target =
      form?.querySelector<HTMLElement>("[aria-invalid='true']") ??
      form?.querySelector<HTMLElement>("[data-form-error]");
    target?.focus();
  }, [focusRequest]);

  const update = (patch: Partial<FormState>) => {
    setForm(current => ({ ...current, ...patch }));
    setServerIssues([]);
    setKeyTaken(false);
    setFormError(null);
  };

  const requestClose = (nextOpen: boolean) => {
    if (!saving) onOpenChange(nextOpen);
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    if (listScenarioBusinessLocationIssues(input).length > 0 || keyInUse) {
      setFocusRequest(request => request + 1);
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const url = businessLocationsApiUrl(workspaceId);
      if (office) {
        const response =
          await requestBusinessLocations<BusinessLocationsSaveResponse>(url, {
            method: "PUT",
            body: { offices: [input] },
          });
        toast.success(t("toasts.saved", { name: input.name }));
        onSaved(response.offices);
      } else {
        const response =
          await requestBusinessLocations<BusinessLocationsCreateResponse>(url, {
            method: "POST",
            body: { office: input },
          });
        toast.success(t("toasts.added", { name: response.office.name }));
        onSaved(response.offices);
      }
      onOpenChange(false);
    } catch (error) {
      const refused =
        error instanceof BusinessLocationsRequestError ? error : null;
      if (refused?.code === "invalid_offices") {
        setServerIssues((refused.body?.rows ?? []).flatMap(row => row.issues));
        setFormError(t("dialog.fixFields"));
      } else if (refused?.code === "office_key_taken") {
        setKeyTaken(true);
      } else {
        setFormError(describeBusinessLocationsError(t, error));
      }
      setFocusRequest(request => request + 1);
    } finally {
      setSaving(false);
    }
  }

  const hintId = (field: FormField) => `${formId}-${field}-hint`;
  const errorId = (field: FormField) => `${formId}-${field}-error`;
  const controlProps = (field: FormField, hasHint = false) => {
    const describedBy = [
      hasHint ? hintId(field) : null,
      errors[field] ? errorId(field) : null,
    ].filter(Boolean);
    return {
      id: `${formId}-${field}`,
      "aria-invalid": errors[field] ? true : undefined,
      "aria-describedby": describedBy.length
        ? describedBy.join(" ")
        : undefined,
    };
  };
  const fieldError = (field: FormField) => {
    const messages = errors[field];
    return messages ? (
      <FieldError
        id={errorId(field)}
        errors={messages.map(message => ({ message }))}
      />
    ) : null;
  };
  const label = (field: FormField, text: string, optional = false) => (
    <FieldLabel htmlFor={`${formId}-${field}`}>
      {text}
      {optional ? (
        <span className="font-normal text-muted-foreground">
          {` (${t("dialog.optional")})`}
        </span>
      ) : null}
    </FieldLabel>
  );

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      {/* Clip, not hidden: below 768px this is the drawer, whose background
          extends below it, and a hidden overflow can still be scrolled by
          focus, leaving a blank sheet with the title out of view. */}
      <DialogContent
        className="flex max-h-[90dvh] flex-col overflow-clip sm:max-w-xl"
        onCloseAutoFocus={event => {
          if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {office ? t("dialog.editTitle") : t("dialog.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          noValidate
          onSubmit={save}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-4"
        >
          {/* Only the fields scroll; the padding keeps focus rings visible,
              the scroll padding the hint under a focused field. */}
          <div className="-m-1 min-h-0 flex-1 scroll-pb-12 overflow-y-auto p-1">
            <fieldset disabled={saving} className="grid min-w-0 gap-4">
              {formError || otherIssues.length > 0 ? (
                <Alert variant="destructive" tabIndex={-1} data-form-error="">
                  <AlertDescription>
                    {[
                      formError,
                      ...otherIssues.map(issue =>
                        describeBusinessLocationIssue(t, issue)
                      ),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </AlertDescription>
                </Alert>
              ) : null}

              <Field className="gap-1.5" data-invalid={Boolean(errors.name)}>
                {label("name", t("dialog.name"))}
                <Input
                  {...controlProps("name")}
                  value={form.name}
                  maxLength={SCENARIO_BUSINESS_LOCATION_LIMITS.nameLength}
                  placeholder={t("dialog.namePlaceholder")}
                  autoComplete="off"
                  onChange={event => update({ name: event.target.value })}
                />
                {fieldError("name")}
              </Field>

              <Field className="gap-1.5" data-invalid={Boolean(errors.key)}>
                {label("key", t("dialog.key"))}
                <Input
                  {...controlProps("key", true)}
                  value={key}
                  readOnly={Boolean(office)}
                  maxLength={SCENARIO_BUSINESS_LOCATION_LIMITS.keyLength}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono read-only:bg-muted read-only:text-muted-foreground"
                  onChange={event =>
                    update({ key: event.target.value, keyEdited: true })
                  }
                />
                <FieldDescription id={hintId("key")}>
                  {office ? t("dialog.keyLocked") : t("dialog.keyHint")}
                </FieldDescription>
                {fieldError("key")}
              </Field>

              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field
                  className="min-w-0 gap-1.5"
                  data-invalid={Boolean(errors.country)}
                >
                  {label("country", t("dialog.country"))}
                  <CountrySelect
                    {...controlProps("country")}
                    aria-label={t("dialog.country")}
                    value={form.country}
                    onChange={country => update({ country })}
                    disabled={saving}
                  />
                  {fieldError("country")}
                </Field>
                <Field
                  className="min-w-0 gap-1.5"
                  data-invalid={Boolean(errors.city)}
                >
                  {label("city", t("dialog.city"))}
                  <Input
                    {...controlProps("city")}
                    value={form.city}
                    maxLength={SCENARIO_BUSINESS_LOCATION_LIMITS.cityLength}
                    placeholder={t("dialog.cityPlaceholder")}
                    onChange={event => update({ city: event.target.value })}
                  />
                  {fieldError("city")}
                </Field>
              </div>

              {/* Full width: addresses run long, and half a row cut off
                  even short ones. */}
              <Field
                className="min-w-0 gap-1.5"
                data-invalid={Boolean(errors.address)}
              >
                {label("address", t("dialog.address"), true)}
                <Input
                  {...controlProps("address")}
                  value={form.address}
                  maxLength={SCENARIO_BUSINESS_LOCATION_LIMITS.addressLength}
                  onChange={event => update({ address: event.target.value })}
                />
                {fieldError("address")}
              </Field>

              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field
                  className="min-w-0 gap-1.5"
                  data-invalid={Boolean(errors.phone)}
                >
                  {label("phone", t("dialog.phone"), true)}
                  <Input
                    {...controlProps("phone")}
                    type="tel"
                    value={form.phone}
                    maxLength={SCENARIO_BUSINESS_LOCATION_LIMITS.phoneLength}
                    onChange={event => update({ phone: event.target.value })}
                  />
                  {fieldError("phone")}
                </Field>
              </div>

              <Field
                className="gap-1.5"
                data-invalid={Boolean(errors.coordinates)}
              >
                {label("coordinates", t("dialog.coordinates"))}
                <Input
                  {...controlProps("coordinates", true)}
                  value={form.coordinates}
                  placeholder={t("dialog.coordinatesPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={event =>
                    update({ coordinates: event.target.value })
                  }
                />
                <div
                  id={hintId("coordinates")}
                  aria-live="polite"
                  className="min-w-0 text-sm"
                >
                  {location.status === "point" ? (
                    <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                      <span className="break-all">
                        {t("dialog.coordinatesPoint", {
                          point: `${location.point.latitude}, ${location.point.longitude}`,
                        })}
                      </span>
                      <a
                        href={buildScenarioLocationMapsUrl(location.point)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {t("openInMaps")}
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    </p>
                  ) : form.coordinates.trim() && !errors.coordinates ? (
                    <p className="text-destructive">{locationMessage}</p>
                  ) : !errors.coordinates ? (
                    <p className="text-muted-foreground">
                      {t("dialog.coordinatesHint")}
                    </p>
                  ) : null}
                </div>
                {fieldError("coordinates")}
              </Field>

              <Field className="gap-1.5" data-invalid={Boolean(errors.mapUrl)}>
                {label("mapUrl", t("dialog.mapUrl"), true)}
                <Input
                  {...controlProps("mapUrl", true)}
                  type="url"
                  inputMode="url"
                  value={form.mapUrl}
                  maxLength={SCENARIO_BUSINESS_LOCATION_LIMITS.mapUrlLength}
                  placeholder="https://"
                  spellCheck={false}
                  onChange={event => update({ mapUrl: event.target.value })}
                />
                <FieldDescription id={hintId("mapUrl")}>
                  {t("dialog.mapUrlHint", { token: "{{office.maps_url}}" })}
                </FieldDescription>
                {fieldError("mapUrl")}
              </Field>

              <Field className="gap-1.5" data-invalid={Boolean(errors.tags)}>
                {label("tags", t("dialog.tags"), true)}
                <TagInput
                  {...controlProps("tags", true)}
                  value={form.tags}
                  onChange={tags => update({ tags: splitTags(tags) })}
                  placeholder={t("dialog.tagsPlaceholder")}
                  disabled={saving}
                  commitOnBlur
                />
                <FieldDescription id={hintId("tags")}>
                  {t("dialog.tagsHint")}
                </FieldDescription>
                {fieldError("tags")}
              </Field>

              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <FieldLabel htmlFor={`${formId}-active`}>
                    {t("dialog.active")}
                  </FieldLabel>
                  <FieldDescription id={`${formId}-active-hint`}>
                    {t("dialog.activeHint")}
                  </FieldDescription>
                </div>
                <Switch
                  id={`${formId}-active`}
                  checked={form.isActive}
                  aria-describedby={`${formId}-active-hint`}
                  onCheckedChange={isActive => update({ isActive })}
                />
              </Field>
            </fieldset>
          </div>
          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => requestClose(false)}
            >
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  {t("dialog.saving")}
                </>
              ) : office ? (
                t("dialog.save")
              ) : (
                t("dialog.create")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
