"use client";

import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  disabled?: boolean;
  /** Id of the text input, for an outside `<label htmlFor>`. */
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  /** Adds the typed text as a tag when the input loses focus. */
  commitOnBlur?: boolean;
}

const EMPTY_SUGGESTIONS: string[] = [];

export function TagInput({
  value,
  onChange,
  placeholder,
  suggestions = EMPTY_SUGGESTIONS,
  disabled = false,
  id,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  commitOnBlur = false,
}: TagInputProps) {
  const [inputValue, setInputValue] = useState("");
  const t = useTranslations("TagInput");

  const handleAddTag = (tagToAdd: string) => {
    const newTag = tagToAdd.trim();
    if (newTag && !value.includes(newTag)) {
      onChange([...value, newTag]);
    }
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      handleAddTag(inputValue);
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    onChange(value.filter(tag => tag !== tagToRemove));
  };

  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap gap-2">
        {value.map(tag => (
          <Badge
            key={tag}
            variant="secondary"
            className="flex max-w-full min-w-0 items-center justify-start gap-1 overflow-visible whitespace-normal"
          >
            <span className="min-w-0 break-words">{tag}</span>
            <button
              type="button"
              aria-label={t("removeTag", { tag })}
              onClick={() => handleRemoveTag(tag)}
              disabled={disabled}
              className="shrink-0 rounded-full p-0.5 hover:bg-muted-foreground/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X size={12} />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        type="text"
        id={id}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={
          commitOnBlur && inputValue.trim()
            ? () => handleAddTag(inputValue)
            : undefined
        }
        placeholder={placeholder || t("placeholder")}
        disabled={disabled}
        className="bg-input"
      />
      {!disabled && suggestions.length > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap gap-2">
          <p className="w-full text-xs text-muted-foreground">
            {t("recommendations")}
          </p>
          {suggestions.map(suggestion =>
            !value.includes(suggestion) ? (
              <Button
                key={suggestion}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleAddTag(suggestion)}
                className="h-auto min-h-8 max-w-full min-w-0 shrink justify-start whitespace-normal break-words py-1.5 text-left leading-snug"
              >
                <Plus className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{suggestion}</span>
              </Button>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}
