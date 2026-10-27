"use client";

import { ScenarioInlineNotice } from "../scenario-inline-notice";
import type { ScenarioFormAnswerNoticeState } from "./use-scenario-ai-prompt-variables";

/**
 * Notices under an AI prompt about its form answers: a warning for answers
 * no earlier form gives, read out when it appears, and a note for answers
 * that may be empty. The prompt field names both in `aria-describedby`.
 */
export function ScenarioFormAnswerNotices({
  notices,
}: {
  notices: ScenarioFormAnswerNoticeState;
}) {
  return (
    <>
      {notices.unavailable ? (
        <ScenarioInlineNotice
          id={notices.unavailableId}
          live
          data-testid="form-answers-unavailable"
        >
          {notices.unavailable}
        </ScenarioInlineNotice>
      ) : null}
      {notices.mayBeEmpty ? (
        <ScenarioInlineNotice
          id={notices.mayBeEmptyId}
          tone="info"
          data-testid="form-answers-may-be-empty"
        >
          {notices.mayBeEmpty}
        </ScenarioInlineNotice>
      ) : null}
    </>
  );
}
