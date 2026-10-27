/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type {
  ScenarioGeneratorAssetRef,
  ScenarioGeneratorBlueprint,
  ScenarioGeneratorChannel,
} from "@icecore/scenario-contracts";
import type { ScenarioSourceInstanceOption } from "../../../scenario-onboarding";
import { SOURCE_MENTION_OPTIONS } from "../shared";
import { AiriCreateDialogCampaignSetupStep } from "./campaign-setup-step";
import { AiriCreateDialogPlanReviewStep } from "./plan-review-step";
import { AiriCreateDialogTemplatesStep } from "./templates-step";

let mockLocale: "en" | "ru" | "kz" = "en";

jest.mock("next-intl", () => {
  const { createCatalogNextIntlMock } = jest.requireActual(
    "@/test-support/next-intl-test-utils"
  );
  const catalog = (locale: string) =>
    createCatalogNextIntlMock(
      jest.requireActual(
        `../../../../../../messages/scenarios/${locale}/page.json`
      ),
      locale
    );
  const catalogs = { en: catalog("en"), ru: catalog("ru"), kz: catalog("kz") };
  return {
    useLocale: () => mockLocale,
    useTranslations: (namespace: string) =>
      catalogs[mockLocale].useTranslations(namespace),
  };
});

const blueprint: ScenarioGeneratorBlueprint = {
  summary: "Win back quiet VIP customers.",
  campaignName: "VIP Reactivation",
  workflowKind: "follow_up_workflow",
  sendMode: "trigger",
  channels: ["whatsapp"],
  recipientSourceSummary: "VIP customers",
  cohorts: [
    { id: "vip", label: "VIP", branchId: "vip", count: 0 },
    { id: "lapsed", label: "Lapsed", branchId: "lapsed", count: 0 },
  ],
};

const mainWhatsApp: ScenarioSourceInstanceOption = {
  id: "main",
  type: "whatsapp",
  label: "Main WhatsApp",
};
const supportWhatsApp: ScenarioSourceInstanceOption = {
  id: "support",
  type: "whatsapp",
  label: "Support",
};

const assets = Array.from({ length: 5 }, (_, index) => ({
  url: `https://storage.example.com/${index}.jpg`,
  source: "uploaded",
})) as ScenarioGeneratorAssetRef[];

function renderPlanReview(assetRefs: ScenarioGeneratorAssetRef[]) {
  render(
    <AiriCreateDialogPlanReviewStep
      wizard={{
        generatorSummary: blueprint.summary,
        readyBlueprint: blueprint,
        assetRefs,
      }}
    />
  );
}

describe("Airi Create steps in the interface language", () => {
  afterEach(() => {
    mockLocale = "en";
  });

  it("keeps the English plan review", () => {
    renderPlanReview(assets.slice(0, 1));

    expect(screen.getByText("Review scenario plan")).toBeInTheDocument();
    expect(screen.getByText("2 groups / 1 media asset")).toBeInTheDocument();
  });

  it("reviews the plan in Russian with Russian plurals", () => {
    mockLocale = "ru";
    renderPlanReview(assets);

    expect(
      screen.getByText("Вот план сценария, который я подготовила.")
    ).toBeInTheDocument();
    expect(screen.getByText("Проверьте план сценария")).toBeInTheDocument();
    expect(screen.getByText("По триггеру")).toBeInTheDocument();
    expect(screen.getByText("Аудитория")).toBeInTheDocument();
    expect(screen.getByText("2 группы / 5 медиафайлов")).toBeInTheDocument();
    expect(screen.queryByText("Review scenario plan")).not.toBeInTheDocument();
  });

  it("reviews the plan in Kazakh", () => {
    mockLocale = "kz";
    renderPlanReview(assets.slice(0, 1));

    expect(
      screen.getByText("Сценарий жоспарын тексеріңіз")
    ).toBeInTheDocument();
    expect(screen.getByText("2 топ / 1 медиа файл")).toBeInTheDocument();
  });

  it("labels sources and accounts in Russian", () => {
    mockLocale = "ru";
    const whatsapp = SOURCE_MENTION_OPTIONS.filter(
      option => option.id === "whatsapp"
    );
    render(
      <AiriCreateDialogCampaignSetupStep
        wizard={{
          generatorStatusLabel: "Готово",
          connectedSourceMentionOptions: whatsapp,
          selectedSourceMentions: [],
          isGeneratorBusy: false,
          handleQuickSourceMention: jest.fn(),
          higgsfieldUnavailableReason: "",
          scopedSourceOptions: [{ ...mainWhatsApp, channel: "whatsapp" }],
          sourceOptionsByType: new Map<
            ScenarioGeneratorChannel,
            ScenarioSourceInstanceOption[]
          >([["whatsapp", [mainWhatsApp, supportWhatsApp]]]),
          sourceScopeByType: {},
          handleToggleSourceScope: jest.fn(),
        }}
      />
    );

    expect(screen.getByText("Настройка сценария")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Добавить канал WhatsApp" })
    ).toHaveTextContent("Отправка");
    expect(
      screen.getByRole("button", {
        name: "Исключить Main WhatsApp из канала WhatsApp",
      })
    ).toBeEnabled();
  });

  it("offers workflow templates in Russian", () => {
    mockLocale = "ru";
    render(
      <AiriCreateDialogTemplatesStep
        wizard={{
          templates: [
            {
              id: "lead-generation",
              title: "Lead Generation Sequence",
              description: "Capture and nurture leads.",
              segmentLabel: "New leads",
              segmentKey: "lead_generation",
            },
          ] as never,
          selectedTemplateId: "",
          selectedTemplate: null,
          isGeneratorBusy: false,
          isCreating: false,
          handleSelectTemplate: jest.fn(),
          handleClearTemplate: jest.fn(),
        }}
      />
    );

    expect(
      screen.getByText("Начните с готового шаблона сценария")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Использовать шаблон «Lead Generation Sequence»",
      })
    ).toBeInTheDocument();
  });
});
