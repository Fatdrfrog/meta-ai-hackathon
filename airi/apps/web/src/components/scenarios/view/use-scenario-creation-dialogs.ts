"use client";

import { useCallback, useState } from "react";
import type { ScenarioGeneratorCreateInput } from "@icecore/scenario-contracts";
import type { ScenarioGuidedCreateKind } from "./scenario-guided-create";
import type { RevenuePlaybookConfig } from "./scenario-revenue-playbooks";

type UseScenarioCreationDialogsParams = {
  createScenarioFromGuide: (
    kind: ScenarioGuidedCreateKind
  ) => Promise<unknown> | unknown;
  createScenarioFromGenerator: (
    input: ScenarioGeneratorCreateInput
  ) => Promise<boolean>;
  createScenarioFromRevenuePlaybook: (
    config: RevenuePlaybookConfig
  ) => Promise<boolean>;
};

export function useScenarioCreationDialogs({
  createScenarioFromGuide,
  createScenarioFromGenerator,
  createScenarioFromRevenuePlaybook,
}: UseScenarioCreationDialogsParams) {
  const [showCreateTypeDialog, setShowCreateTypeDialog] = useState(false);
  const [showAiriCreateDialog, setShowAiriCreateDialog] = useState(false);
  const [showRevenuePlaybookDialog, setShowRevenuePlaybookDialog] =
    useState(false);
  const handleOpenRevenuePlaybook = useCallback(() => {
    setShowCreateTypeDialog(false);
    setShowRevenuePlaybookDialog(true);
  }, []);
  const handleCreateRevenuePlaybook = useCallback(
    async (config: RevenuePlaybookConfig) => {
      const created = await createScenarioFromRevenuePlaybook(config);
      if (created) setShowRevenuePlaybookDialog(false);
      return created;
    },
    [createScenarioFromRevenuePlaybook]
  );

  const handleGuidedScenarioCreate = useCallback(
    (kind: ScenarioGuidedCreateKind) => {
      setShowCreateTypeDialog(false);
      void createScenarioFromGuide(kind);
    },
    [createScenarioFromGuide]
  );

  const handleCreateGeneratedScenario = useCallback(
    async (input: ScenarioGeneratorCreateInput) => {
      const created = await createScenarioFromGenerator(input);
      if (created) {
        setShowAiriCreateDialog(false);
      }
      return created;
    },
    [createScenarioFromGenerator]
  );

  return {
    showCreateTypeDialog,
    setShowCreateTypeDialog,
    showAiriCreateDialog,
    setShowAiriCreateDialog,
    handleGuidedScenarioCreate,
    handleCreateGeneratedScenario,
    showRevenuePlaybookDialog,
    setShowRevenuePlaybookDialog,
    handleOpenRevenuePlaybook,
    handleCreateRevenuePlaybook,
  };
}
