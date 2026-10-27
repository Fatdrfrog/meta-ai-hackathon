"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useTranslations } from "next-intl";
import { useId } from "react";
import {
  availableServiceProducts,
  type WhatsAppServiceCatalogProduct,
} from "./service-message-resources";

export function ServiceMessageProductPicker({
  products,
  catalogId,
  selectedIds,
  disabledIds = new Set<string>(),
  max,
  onChange,
}: {
  products: WhatsAppServiceCatalogProduct[];
  catalogId: string;
  selectedIds: string[];
  disabledIds?: Set<string>;
  max: number;
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations("Scenarios");
  const counterId = useId();
  const selected = new Set(selectedIds);
  const options = availableServiceProducts({ products, catalogId });

  if (options.length === 0) {
    return (
      <p className="rounded-md border bg-background px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        {t("whatsappServiceProductsUnavailable")}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div className="nowheel max-h-40 space-y-1 overflow-y-auto overscroll-contain rounded-md border bg-background p-1.5">
        {options.map((product, index) => {
          const id = product.retailer_id!;
          const checked = selected.has(id);
          const atLimit = !checked && selectedIds.length >= max;
          const disabled = atLimit || (!checked && disabledIds.has(id));
          const label =
            product.name || `${t("whatsappServiceProductOption")} ${index + 1}`;
          return (
            <label
              key={id}
              className="flex min-h-8 items-center gap-2 rounded px-1.5 text-xs hover:bg-muted/50"
            >
              <Checkbox
                checked={checked}
                disabled={disabled}
                aria-describedby={atLimit ? counterId : undefined}
                onCheckedChange={nextChecked =>
                  onChange(
                    nextChecked === true
                      ? [...selectedIds, id]
                      : selectedIds.filter(current => current !== id)
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </label>
          );
        })}
      </div>
      <p
        id={counterId}
        className="text-right text-[11px] tabular-nums text-muted-foreground"
      >
        {t("whatsappServiceProductsSelected", {
          count: selectedIds.length,
          max,
        })}
      </p>
    </div>
  );
}
