"use client";

import { memo } from "react";
import type { ScenarioTriggerEditorNodeProps } from "../../view/node-enrichment/types";
import { areNodePropsEqual } from "../node-memo-utils";
import { CompactTriggerNode } from "./trigger-node-compact";

export const TriggerNode = memo(function TriggerNode(
  props: ScenarioTriggerEditorNodeProps
) {
  return <CompactTriggerNode {...props} />;
}, areNodePropsEqual);
