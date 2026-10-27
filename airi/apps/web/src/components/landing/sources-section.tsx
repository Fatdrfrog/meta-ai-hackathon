"use client";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { INTEGRATIONS } from "@/components/integrations/integration-registry";
import { useTranslations } from "next-intl";
import s from "./landing-workflow-studio.module.css";

export function SourcesSection() {
  const t = useTranslations("LandingDemo.sources");
  const integrationT = useTranslations("IntegrationRegistry");
  // The heading promises WhatsApp first, so the list leads with it too.
  const channels = INTEGRATIONS.filter(
    integration =>
      !integration.disabled &&
      (integration.category === "channel" || integration.category === "widget")
  ).sort((a, b) => Number(b.id === "whatsapp") - Number(a.id === "whatsapp"));
  return (
    <section
      id="integrations"
      aria-labelledby="landing-channels-title"
      className={s.channels}
    >
      <div className={s.channelsInner}>
        <div>
          <h2 id="landing-channels-title">{t("title")}</h2>
          <p>{t("description")}</p>
        </div>
        <ul className={s.channelList}>
          {channels.map(integration => (
            <li key={integration.id}>
              <IntegrationIcon
                integration={integration}
                alt=""
                theme="light"
                className="size-5"
              />
              <span>
                {integration.id === "web_widget"
                  ? t("website")
                  : integrationT(integration.id + ".name")}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
