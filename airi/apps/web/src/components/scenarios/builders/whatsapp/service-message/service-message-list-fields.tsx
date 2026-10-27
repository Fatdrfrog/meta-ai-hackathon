"use client";

import { SCENARIO_HANDLE_ANCHOR_CLASS } from "@/components/scenarios/source-handle-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppInteractiveOption,
  type ScenarioWhatsAppListRow,
  type ScenarioWhatsAppListSection,
} from "@icecore/scenario-contracts";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import {
  ServiceGroupError,
  ServiceMessageInput as Input,
} from "./service-message-field";
import type { ServiceMessageListEditorIntent } from "./service-message-editor-model";

function ServiceMessageListRow({
  row,
  fieldKey,
  renderBranchHandle,
  onIntent,
}: {
  row: ScenarioWhatsAppListRow;
  /** `sections.<s>.rows.<r>`, the row's diagnostic path. */
  fieldKey: string;
  renderBranchHandle?: (option: ScenarioWhatsAppInteractiveOption) => ReactNode;
  onIntent: (intent: ServiceMessageListEditorIntent) => void;
}) {
  const t = useTranslations("Scenarios");
  // The description stays optional until the author asks for it.
  const [showDescription, setShowDescription] = useState(false);
  const option = { id: row.id, label: row.title };
  const descriptionVisible = showDescription || Boolean(row.description);
  return (
    <div className="relative space-y-1 overflow-visible">
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          SCENARIO_HANDLE_ANCHOR_CLASS
        )}
      >
        <Input
          className="nodrag h-8 min-w-0 flex-1 text-xs"
          maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowTitle}
          fieldKey={fieldKey + ".title"}
          value={row.title}
          aria-label={t("whatsappServiceListOptionLabel")}
          onChange={event =>
            onIntent({
              type: "set_list_row_title",
              rowId: row.id,
              value: event.target.value,
            })
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="nodrag nopan h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          title={t("whatsappServiceDeleteOption")}
          aria-label={t("whatsappServiceDeleteOption")}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => onIntent({ type: "remove_choice", optionId: row.id })}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
        {renderBranchHandle?.(option)}
      </div>
      {descriptionVisible ? (
        <Input
          className="nodrag h-8 text-xs"
          maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowDescription}
          fieldKey={fieldKey + ".description"}
          value={row.description || ""}
          aria-label={t("whatsappServiceListDescriptionPlaceholder")}
          placeholder={t("whatsappServiceListDescriptionPlaceholder")}
          autoFocus={showDescription && !row.description}
          onChange={event =>
            onIntent({
              type: "set_list_row_description",
              rowId: row.id,
              value: event.target.value,
            })
          }
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="nodrag nopan h-6 px-1.5 text-[11px] text-muted-foreground"
          onPointerDown={event => event.stopPropagation()}
          onClick={() => setShowDescription(true)}
        >
          <Plus className="h-3 w-3" aria-hidden />
          {t("whatsappServiceListAddDescription")}
        </Button>
      )}
    </div>
  );
}

export function ServiceMessageListFields({
  sections,
  createEntityId,
  createOptionId,
  renderBranchHandle,
  onIntent,
}: {
  sections: ScenarioWhatsAppListSection[];
  createEntityId: () => string;
  createOptionId: () => string;
  renderBranchHandle?: (option: ScenarioWhatsAppInteractiveOption) => ReactNode;
  onIntent: (intent: ServiceMessageListEditorIntent) => void;
}) {
  const t = useTranslations("Scenarios");
  const rowCount = sections.reduce(
    (total, section) => total + section.rows.length,
    0
  );

  return (
    <div className="space-y-2" data-sm-field="sections">
      {sections.map((section, sectionIndex) => (
        <div
          key={section.id}
          className={`space-y-1.5${sectionIndex > 0 ? " border-t border-border/50 pt-2" : ""}`}
        >
          {/* A single list section needs no title, so an empty one stays out of the way. */}
          {sections.length > 1 || section.title ? (
            <div className="flex gap-1.5">
              <Input
                className="nodrag h-8 min-w-0 flex-1 text-xs"
                maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sectionTitle}
                fieldKey={"sections." + sectionIndex + ".title"}
                value={section.title || ""}
                aria-label={t("whatsappServiceListSectionPlaceholder")}
                placeholder={t("whatsappServiceListSectionPlaceholder")}
                onChange={event =>
                  onIntent({
                    type: "set_list_section_title",
                    sectionId: section.id,
                    value: event.target.value,
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag nopan h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                title={t("whatsappServiceDeleteSection")}
                aria-label={t("whatsappServiceDeleteSection")}
                onPointerDown={event => event.stopPropagation()}
                onClick={() =>
                  onIntent({
                    type: "remove_list_section",
                    sectionId: section.id,
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}

          {section.rows.map((row, rowIndex) => (
            <ServiceMessageListRow
              key={row.id}
              row={row}
              fieldKey={"sections." + sectionIndex + ".rows." + rowIndex}
              renderBranchHandle={renderBranchHandle}
              onIntent={onIntent}
            />
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="nodrag h-8 w-full border-dashed"
            disabled={rowCount >= WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max}
            onClick={() =>
              onIntent({
                type: "add_list_row",
                sectionId: section.id,
                row: {
                  id: createOptionId(),
                  title: "",
                  description: undefined,
                },
              })
            }
          >
            <Plus className="mr-2 h-3.5 w-3.5" aria-hidden />
            {t("whatsAppSessionChoiceAddOption")}
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="nodrag h-8 w-full border-dashed"
        disabled={
          sections.length >= WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sections.max
        }
        onClick={() =>
          onIntent({
            type: "add_list_section",
            section: { id: createEntityId(), title: "", rows: [] },
          })
        }
      >
        <Plus className="mr-2 h-3.5 w-3.5" aria-hidden />
        {t("whatsappServiceAddSection")}
      </Button>
      {/* Section and option counts are errors of the whole list. */}
      <ServiceGroupError fieldKey="sections" />
    </div>
  );
}
