"use client";

import {
  AlertCircleIcon,
  FilterIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { WhatsAppQrSourceOption } from "./types";
import {
  useWhatsAppQrManager,
  type WhatsAppQrManagerFilters,
} from "./use-whatsapp-qr-manager";
import { WhatsAppQrList } from "./whatsapp-qr-list";
import {
  WhatsAppQrProvisionDialog,
  type WhatsAppQrProvisionIntent,
} from "./whatsapp-qr-provision-dialog";

export type WhatsAppQrPageProps = {
  workspaceId: string;
  sourceOptions: readonly WhatsAppQrSourceOption[];
};

type ProvisionState = {
  open: boolean;
  intent: WhatsAppQrProvisionIntent;
};

function filterValue(facet: WhatsAppQrManagerFilters["facet"]): string {
  if (facet.kind === "all") return "all";
  if (facet.kind === "source") return `source:${facet.sourceId}`;
  if (facet.kind === "status") return `status:${facet.status}`;
  return `assignment:${facet.assignment}`;
}

export function WhatsAppQrManager({
  workspaceId,
  sourceOptions,
}: WhatsAppQrPageProps) {
  const t = useTranslations("WhatsAppQr");
  const router = useRouter();
  const controller = useWhatsAppQrManager({ workspaceId });
  const [provision, setProvision] = useState<ProvisionState>({
    open: false,
    intent: "create",
  });
  const sourceLabels = useMemo(
    () => new Map(sourceOptions.map(source => [source.id, source.label])),
    [sourceOptions]
  );

  const openProvision = (intent: WhatsAppQrProvisionIntent) => {
    setProvision({ open: true, intent });
  };

  const setFacet = (value: string) => {
    let facet: WhatsAppQrManagerFilters["facet"] = { kind: "all" };
    if (value.startsWith("source:")) {
      const sourceId = value.slice("source:".length);
      if (sourceId) facet = { kind: "source", sourceId };
    } else if (value.startsWith("status:")) {
      const status = value.slice("status:".length);
      if (status === "DRAFT" || status === "ACTIVE" || status === "DETACHED") {
        facet = { kind: "status", status };
      }
    } else if (value.startsWith("assignment:")) {
      const assignment = value.slice("assignment:".length);
      if (assignment === "assigned" || assignment === "unassigned") {
        facet = { kind: "assignment", assignment };
      }
    }
    controller.setFilters(current => ({ ...current, facet }));
  };

  const activeFilterLabel = (() => {
    const facet = controller.filters.facet;
    if (facet.kind === "all") return null;
    if (facet.kind === "source") {
      return t("filter.activeSource", {
        value: sourceLabels.get(facet.sourceId) || t("card.sourceUnavailable"),
      });
    }
    if (facet.kind === "status") {
      return t("filter.activeStatus", { value: t(`status.${facet.status}`) });
    }
    return t("filter.activeAssignment", {
      value: t(`filter.${facet.assignment}`),
    });
  })();

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        primaryAction={
          <Button type="button" onClick={() => openProvision("create")}>
            <PlusIcon data-icon="inline-start" />
            {t("actions.create")}
          </Button>
        }
        secondaryAction={
          <Button
            type="button"
            variant="ghost"
            onClick={() => openProvision("import")}
          >
            <UploadIcon data-icon="inline-start" />
            {t("actions.import")}
          </Button>
        }
      />

      <div className="flex min-w-0 items-center gap-2">
        <Field className="min-w-0 flex-1">
          <FieldLabel className="sr-only" htmlFor="whatsapp-qr-search">
            {t("manager.searchLabel")}
          </FieldLabel>
          <div className="relative min-w-0">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="whatsapp-qr-search"
              value={controller.filters.query}
              onChange={event =>
                controller.setFilters(current => ({
                  ...current,
                  query: event.target.value,
                }))
              }
              placeholder={t("manager.searchPlaceholder")}
              autoComplete="off"
              className="min-w-0 pl-9"
            />
          </div>
        </Field>

        <TooltipProvider>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant={activeFilterLabel ? "secondary" : "outline"}
                    aria-label={activeFilterLabel || t("actions.filter")}
                    aria-pressed={Boolean(activeFilterLabel)}
                  >
                    <FilterIcon />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>
                {activeFilterLabel || t("actions.filter")}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuRadioGroup
                value={filterValue(controller.filters.facet)}
                onValueChange={setFacet}
              >
                <DropdownMenuGroup>
                  <DropdownMenuRadioItem value="all">
                    {t("filter.all")}
                  </DropdownMenuRadioItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("filter.source")}</DropdownMenuLabel>
                  {sourceOptions.map(source => (
                    <DropdownMenuRadioItem
                      key={source.id}
                      value={`source:${source.id}`}
                    >
                      {source.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("filter.status")}</DropdownMenuLabel>
                  {(["DRAFT", "ACTIVE", "DETACHED"] as const).map(status => (
                    <DropdownMenuRadioItem
                      key={status}
                      value={`status:${status}`}
                    >
                      {t(`status.${status}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {t("filter.assignment")}
                  </DropdownMenuLabel>
                  {(["assigned", "unassigned"] as const).map(assignment => (
                    <DropdownMenuRadioItem
                      key={assignment}
                      value={`assignment:${assignment}`}
                    >
                      {t(`filter.${assignment}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={controller.loading}
                onClick={() => void controller.refresh()}
                aria-label={
                  controller.loading
                    ? t("manager.refreshing")
                    : t("actions.refresh")
                }
              >
                <RefreshCwIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {controller.loading
                ? t("manager.refreshing")
                : t("actions.refresh")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {activeFilterLabel ? (
        <div className="flex min-w-0 items-center">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="max-w-full"
            onClick={() =>
              controller.setFilters(current => ({
                ...current,
                facet: { kind: "all" },
              }))
            }
            aria-label={`${activeFilterLabel}. ${t("actions.clearFilter")}`}
          >
            <span className="min-w-0 truncate">{activeFilterLabel}</span>
            <XIcon data-icon="inline-end" />
          </Button>
        </div>
      ) : null}

      <WhatsAppQrList
        workspaceId={workspaceId}
        sourceOptions={sourceOptions}
        controller={controller}
        onCreate={() => openProvision("create")}
      />

      <WhatsAppQrProvisionDialog
        open={provision.open}
        onOpenChange={open => setProvision(current => ({ ...current, open }))}
        initialIntent={provision.intent}
        workspaceId={workspaceId}
        sourceOptions={sourceOptions}
        onCompleted={entryPointId => {
          setProvision(current => ({ ...current, open: false }));
          void controller.refresh();
          router.push(
            `/panel/w/${workspaceId}/messengers/whatsapp-qr/${encodeURIComponent(entryPointId)}`
          );
        }}
      />
    </div>
  );
}

export function WhatsAppQrSourceLoadError() {
  const t = useTranslations("WhatsAppQr");
  const router = useRouter();

  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>{t("source.loadErrorTitle")}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{t("source.loadErrorDescription")}</span>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.refresh()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {t("actions.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
