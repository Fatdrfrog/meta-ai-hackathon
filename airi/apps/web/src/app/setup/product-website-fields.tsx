"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useId, useRef, useState } from "react";

export type ProductWebsiteRow = { id: string; value: string };

type WebsiteFocusRequest =
  | { target: "row"; rowId: string; version: number }
  | { target: "add"; version: number }
  | null;

export function useProductWebsiteRows(maxRows: number) {
  const generatedIdPrefix = useId().replace(/:/g, "");
  const nextIdRef = useRef(2);
  const focusVersionRef = useRef(0);
  const [rows, setRows] = useState<ProductWebsiteRow[]>([
    { id: "website-1", value: "" },
  ]);
  const [focusRequest, setFocusRequest] = useState<WebsiteFocusRequest>(null);

  const updateRow = useCallback((rowId: string, value: string) => {
    setRows(current =>
      current.map(row => (row.id === rowId ? { ...row, value } : row))
    );
  }, []);

  const addRow = useCallback(() => {
    if (rows.length >= maxRows) return;
    const rowId = `${generatedIdPrefix}-website-${nextIdRef.current}`;
    nextIdRef.current += 1;
    setRows(current => [...current, { id: rowId, value: "" }]);
    focusVersionRef.current += 1;
    setFocusRequest({
      target: "row",
      rowId,
      version: focusVersionRef.current,
    });
  }, [generatedIdPrefix, maxRows, rows.length]);

  const removeRow = useCallback(
    (rowId: string) => {
      const removedIndex = rows.findIndex(row => row.id === rowId);
      if (removedIndex < 0) return;
      const nextRows = rows.filter(row => row.id !== rowId);
      setRows(nextRows);
      focusVersionRef.current += 1;
      const nearest = nextRows[Math.min(removedIndex, nextRows.length - 1)];
      setFocusRequest(
        nearest
          ? {
              target: "row",
              rowId: nearest.id,
              version: focusVersionRef.current,
            }
          : { target: "add", version: focusVersionRef.current }
      );
    },
    [rows]
  );

  return { rows, updateRow, addRow, removeRow, focusRequest };
}

type ProductWebsiteFieldsProps = {
  rows: ProductWebsiteRow[];
  errors: ReadonlyMap<string, string>;
  maxRows: number;
  focusRequest: WebsiteFocusRequest;
  onChange(rowId: string, value: string): void;
  onBlur(rowId: string): void;
  onAdd(): void;
  onRemove(rowId: string): void;
};

export function ProductWebsiteFields({
  rows,
  errors,
  maxRows,
  focusRequest,
  onChange,
  onBlur,
  onAdd,
  onRemove,
}: ProductWebsiteFieldsProps) {
  const t = useTranslations("OnboardingProductStep");
  const handledFocusVersionRef = useRef(0);

  const setInputRef = useCallback(
    (rowId: string) => (node: HTMLInputElement | null) => {
      if (
        !node ||
        focusRequest?.target !== "row" ||
        focusRequest.rowId !== rowId ||
        handledFocusVersionRef.current >= focusRequest.version
      ) {
        return;
      }
      handledFocusVersionRef.current = focusRequest.version;
      node.focus();
    },
    [focusRequest]
  );
  const setAddButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (
        !node ||
        focusRequest?.target !== "add" ||
        handledFocusVersionRef.current >= focusRequest.version
      ) {
        return;
      }
      handledFocusVersionRef.current = focusRequest.version;
      node.focus();
    },
    [focusRequest]
  );

  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="break-words text-sm font-bold text-foreground">
        {t("websitesLabel")}
      </legend>
      <p className="break-words text-xs text-muted-foreground">
        {t("websitesHelp")}
      </p>

      <div className="space-y-2">
        {rows.map((row, index) => {
          const error = errors.get(row.id);
          const errorId = `website-error-${row.id}`;
          return (
            <div key={row.id} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Input
                  ref={setInputRef(row.id)}
                  value={row.value}
                  onChange={event => onChange(row.id, event.target.value)}
                  onBlur={() => onBlur(row.id)}
                  onKeyDown={event => {
                    if (event.key !== "Enter") return;

                    event.preventDefault();
                    if (index === rows.length - 1 && rows.length < maxRows) {
                      onAdd();
                    }
                  }}
                  aria-label={t("websiteInputLabel", { number: index + 1 })}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                  placeholder={t("websitePlaceholder")}
                  inputMode="url"
                  className="h-12 rounded-2xl border-[3px] border-foreground bg-background p-3 text-foreground transition-all focus-visible:translate-x-[1px] focus-visible:translate-y-[1px] focus-visible:border-primary focus-visible:ring-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(row.id)}
                  aria-label={t("removeWebsiteLabel", { number: index + 1 })}
                  className="rounded-xl border-2 border-transparent hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {error ? (
                <p
                  id={errorId}
                  className="text-xs font-semibold leading-5 text-destructive"
                >
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {rows.length < maxRows ? (
        <Button
          ref={setAddButtonRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="h-10 gap-1.5 rounded-xl border-[3px] border-foreground bg-background px-4 py-2 font-bold text-foreground shadow-[3px_3px_0px_#000000] transition-all hover:scale-[1.02] hover:bg-[#c9cfff]/20 active:scale-95 dark:shadow-[3px_3px_0px_rgba(255,255,255,0.15)]"
        >
          <Plus className="h-3.5 w-3.5 stroke-[3px]" />
          {t("addWebsite")}
        </Button>
      ) : null}
    </fieldset>
  );
}
