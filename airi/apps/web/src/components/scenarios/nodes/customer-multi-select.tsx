"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useMemo, useState, type SyntheticEvent } from "react";
import type { ScenarioAudienceCustomer, TranslateFn } from "../types";
import { filterScenarioAudienceCustomers } from "./utils";

type ScenarioCustomerMultiSelectProps = {
  customers: ScenarioAudienceCustomer[];
  selectedCustomerIds: string[];
  t: TranslateFn;
  onToggle: (customerId: string) => void;
  disabled?: boolean;
};

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

export function ScenarioCustomerMultiSelect({
  customers,
  selectedCustomerIds,
  t,
  onToggle,
  disabled = false,
}: ScenarioCustomerMultiSelectProps) {
  const [query, setQuery] = useState("");
  const filteredCustomers = useMemo(
    () => filterScenarioAudienceCustomers(customers, query),
    [customers, query]
  );

  return (
    <div className="space-y-1">
      <Input
        value={query}
        disabled={disabled}
        onChange={event => setQuery(event.target.value)}
        aria-label={t("searchCustomersLabel")}
        placeholder={t("searchCustomers")}
        className="nodrag nopan nokey h-8"
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
        onKeyDown={stopPropagation}
      />
      <div className="nowheel max-h-40 space-y-1 overflow-y-auto rounded-md border bg-background p-1.5">
        {filteredCustomers.length > 0 ? (
          filteredCustomers.map(customer => (
            <label
              key={customer.id}
              className="nodrag nopan flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-[11px] hover:bg-muted/60 has-[:disabled]:cursor-not-allowed"
              onPointerDown={stopPropagation}
              onClick={stopPropagation}
            >
              <Checkbox
                className="nokey"
                checked={selectedCustomerIds.includes(customer.id)}
                disabled={disabled}
                onCheckedChange={() => onToggle(customer.id)}
              />
              <span className="truncate">{customer.label}</span>
            </label>
          ))
        ) : (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {t(query.trim() ? "noCustomersMatch" : "noCustomersYet")}
          </div>
        )}
      </div>
    </div>
  );
}
