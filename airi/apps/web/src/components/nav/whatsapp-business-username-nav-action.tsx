"use client";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

type UsernameStatusPayload = {
  canCreate?: boolean;
  connected?: boolean;
  error?: string;
  hasUsername?: boolean;
  suggestions?: string[];
  username?: string;
};

type TransferAction = "none" | "force_transfer";
type UsernameStatusKey = readonly [
  "whatsapp-username",
  string,
  "status" | "suggestions",
];

function cleanUsernameInput(value: string): string {
  return value.trim().replace(/^@+/, "").trim();
}

async function readJson(response: Response): Promise<UsernameStatusPayload> {
  try {
    return (await response.json()) as UsernameStatusPayload;
  } catch {
    return {};
  }
}

async function fetchUsernameStatus([
  ,
  workspaceId,
  mode,
]: UsernameStatusKey): Promise<UsernameStatusPayload> {
  const query = new URLSearchParams({ workspaceId });
  if (mode === "suggestions") query.set("includeSuggestions", "1");
  const response = await fetch(`/api/whatsapp/username?${query}`, {
    cache: "no-store",
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload.error || "WhatsApp username is unavailable.");
  }
  return payload;
}

export function WhatsAppBusinessUsernameNavAction({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [hiddenAfterSuccess, setHiddenAfterSuccess] = useState(false);
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [username, setUsername] = useState("");
  const [transferAction, setTransferAction] = useState<TransferAction>("none");
  const [error, setError] = useState<string | null>(null);
  const statusKey = useMemo<UsernameStatusKey>(
    () => ["whatsapp-username", workspaceId, "status"],
    [workspaceId]
  );
  const {
    data: statusPayload,
    error: statusError,
    isLoading,
    mutate: mutateStatus,
  } = useSWR<UsernameStatusPayload>(statusKey, fetchUsernameStatus, {
    revalidateOnFocus: false,
  });
  const canCreate =
    !statusError &&
    statusPayload?.canCreate === true &&
    statusPayload.hasUsername !== true;
  const suggestionsKey = useMemo<UsernameStatusKey | null>(
    () =>
      open && canCreate
        ? ["whatsapp-username", workspaceId, "suggestions"]
        : null,
    [canCreate, open, workspaceId]
  );
  const { data: suggestionsPayload, isLoading: isSuggestionsLoading } =
    useSWR<UsernameStatusPayload>(suggestionsKey, fetchUsernameStatus, {
      revalidateOnFocus: false,
    });
  const suggestions = suggestionsPayload?.suggestions || [];

  const normalizedUsername = cleanUsernameInput(username);
  const showAction = !hiddenAfterSuccess && !isLoading && canCreate;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setError(null);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!normalizedUsername) {
      setError("Enter a username.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/whatsapp/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transferAction,
          username: normalizedUsername,
          workspaceId,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(payload.error || "Failed to create username.");
      }

      setHiddenAfterSuccess(true);
      void mutateStatus(
        {
          ...statusPayload,
          canCreate: false,
          hasUsername: true,
          username: payload.username || normalizedUsername,
        },
        { revalidate: false }
      );
      setOpen(false);
      toast.success(
        `WhatsApp @${payload.username || normalizedUsername} saved.`
      );
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to create username."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!showAction) return null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="hidden h-8 shrink-0 px-2 text-xs lg:inline-flex"
        >
          <span>Create WhatsApp</span>
          <span className="font-semibold text-sky-600 dark:text-sky-400">
            @username
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">Create WhatsApp @username</p>
            <p className="text-xs text-muted-foreground">
              Reserve a handle for this connected WhatsApp number.
            </p>
          </div>

          <FieldGroup className="gap-3">
            <Field data-invalid={Boolean(error)}>
              <FieldLabel
                htmlFor="whatsapp-business-username"
                className="text-xs"
              >
                Username
              </FieldLabel>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  @
                </span>
                <Input
                  id="whatsapp-business-username"
                  value={username}
                  onChange={event => {
                    setUsername(event.target.value);
                    setError(null);
                  }}
                  placeholder="brandname"
                  autoComplete="off"
                  className="h-8 pl-7"
                  aria-invalid={Boolean(error)}
                />
              </div>
              <FieldError className="text-xs">{error}</FieldError>
            </Field>

            {isSuggestionsLoading || suggestions.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {isSuggestionsLoading ? (
                  <span className="text-xs text-muted-foreground">
                    Loading suggestions...
                  </span>
                ) : (
                  suggestions.map(suggestion => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        setUsername(suggestion);
                        setError(null);
                      }}
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs transition",
                        cleanUsernameInput(username) === suggestion
                          ? "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
                          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      @{suggestion}
                    </button>
                  ))
                )}
              </div>
            ) : null}

            <Field>
              <FieldLabel className="text-xs">If already used here</FieldLabel>
              <Select
                value={transferAction}
                onValueChange={value =>
                  setTransferAction(
                    value === "force_transfer" ? "force_transfer" : "none"
                  )
                }
              >
                <SelectTrigger size="sm" className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="none">Do not transfer</SelectItem>
                    <SelectItem value="force_transfer">
                      Transfer from another number
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>

          <Button
            type="submit"
            variant="secondary"
            size="sm"
            className="h-8"
            disabled={isSubmitting || !normalizedUsername}
          >
            {isSubmitting ? <Loader2 className="animate-spin" /> : null}
            Create
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
