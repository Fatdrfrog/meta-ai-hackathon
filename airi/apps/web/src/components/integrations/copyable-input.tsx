"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

interface CopyableInputProps {
  value: string;
  label?: string;
  description?: string;
  copySuccessMessage?: string;
  copyLabel?: string;
  copyFailureMessage?: string;
  className?: string;
}

export function CopyableInput({
  value,
  label,
  description,
  copySuccessMessage = "Copied to clipboard",
  copyLabel = "Copy",
  copyFailureMessage = "Failed to copy",
  className,
}: CopyableInputProps) {
  const [copied, setCopied] = useState(false);
  const inputId = useId();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(copySuccessMessage);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(copyFailureMessage);
    }
  };

  return (
    <div className={className}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium mb-2 block">
          {label}
        </label>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={value}
          readOnly
          className="font-mono text-sm bg-muted/50"
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={handleCopy}
          aria-label={copyLabel}
          className="shrink-0"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground mt-1.5">{description}</p>
      )}
    </div>
  );
}
