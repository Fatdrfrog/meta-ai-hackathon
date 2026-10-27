import { useState } from "react";
import { useTranslations } from "next-intl";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import { WhatsAppTemplatePickerField } from "../src/components/scenarios/nodes/action-node/action-node-whatsapp-template-section-ui";
import { ScenarioInlineNotice } from "../src/components/scenarios/scenario-inline-notice";
import { fetchWhatsAppTemplateCatalog } from "../src/lib/whatsapp/templates/catalog-client";

// Exercise the real picker and shared client against the intercepted HTTP
// boundary. Resource-owner retry and invalidation behavior is covered by Jest.
export function WhatsAppTemplatesBrowserScenario() {
  const t = useTranslations("templates.alerts");
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  async function load(force = false) {
    setLoading(true);
    try {
      const result = await fetchWhatsAppTemplateCatalog({
        workspaceId: "browser-workspace",
        status: "APPROVED",
        force,
      });
      setTemplates(result.metaTemplates);
      setStale(Boolean(result.catalog?.stale || result.error));
      setCoolingDown(
        Date.parse(result.catalog?.retryAt || result.error?.retryAt || "") >
          Date.now()
      );
    } catch {
      setStale(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-xl border p-4">
      <WhatsAppTemplatePickerField
        id="browser-scenario-template"
        options={templates}
        value={value}
        open={open}
        onOpenChange={next => {
          setOpen(next);
          if (next) void load();
        }}
        onSelect={next => {
          setValue(next);
          setOpen(false);
        }}
        loading={loading}
        listLoading={loading}
        loadingLabel="Loading templates"
        shared={false}
        unverified={false}
        onRefresh={() => void load(true)}
        refreshDisabled={loading || coolingDown}
      />
      {stale ? (
        <ScenarioInlineNotice>{t("savedTemplates")}</ScenarioInlineNotice>
      ) : null}
    </div>
  );
}
