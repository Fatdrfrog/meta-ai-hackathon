"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "next-intl";
import { useState } from "react";

export interface LinkEditDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when dialog should close */
  onOpenChange: (open: boolean) => void;
  /** Initial URL value */
  initialUrl?: string;
  /** Initial link text value */
  initialText?: string;
  /** Callback when link is saved */
  onSave: (url: string, text?: string) => void;
}

/**
 * Shared link edit dialog component for KB editors
 * Provides a proper dialog interface for editing links instead of window.prompt()
 */
export function LinkEditDialog({
  open,
  onOpenChange,
  initialUrl = "",
  initialText = "",
  onSave,
}: LinkEditDialogProps) {
  return (
    <LinkEditDialogContent
      key={`${open ? "open" : "closed"}:${initialUrl}:${initialText}`}
      open={open}
      onOpenChange={onOpenChange}
      initialUrl={initialUrl}
      initialText={initialText}
      onSave={onSave}
    />
  );
}

function LinkEditDialogContent({
  open,
  onOpenChange,
  initialUrl,
  initialText,
  onSave,
}: Required<LinkEditDialogProps>) {
  const t = useTranslations("EnhancedMarkdownEditor");
  const [url, setUrl] = useState(initialUrl);
  const [text, setText] = useState(initialText);

  // Safe translation helper that returns fallback if key doesn't exist
  const safeT = (key: string, fallback: string): string => {
    try {
      return t(key);
    } catch {
      return fallback;
    }
  };

  const handleSave = () => {
    if (!url.trim()) {
      return;
    }
    onSave(url.trim(), text.trim() || undefined);
    onOpenChange(false);
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{safeT("link", "Link")}</DialogTitle>
          <DialogDescription>
            {safeT(
              "linkDialogDescription",
              "Enter the URL and optionally customize the link text."
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="link-url">
              {safeT("linkUrl", "URL")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="link-url"
              type="url"
              placeholder="https://example.com"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="link-text">
              {safeT("linkText", "Link Text")} (optional)
            </Label>
            <Input
              id="link-text"
              type="text"
              placeholder={safeT("linkTextPlaceholder", "Display text")}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {safeT("cancel", "Cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!url.trim()}>
            {safeT("save", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
