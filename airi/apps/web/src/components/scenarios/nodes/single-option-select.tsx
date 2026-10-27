"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { NONE_OPTION_VALUE } from "./utils";

type ScenarioSingleOptionSelectProps = {
  label: string;
  value: string;
  placeholder: string;
  emptyLabel: string;
  options: string[];
  onValueChange: (value: string) => void;
};

export function ScenarioSingleOptionSelect({
  label,
  value,
  placeholder,
  emptyLabel,
  options,
  onValueChange,
}: ScenarioSingleOptionSelectProps) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="nodrag h-8">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_OPTION_VALUE}>{emptyLabel}</SelectItem>
          {options.map(option => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
