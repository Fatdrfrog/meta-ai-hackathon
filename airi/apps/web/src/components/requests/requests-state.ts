import { atomWithStorage } from "jotai/utils";

export type RequestsDialogSearchType =
  | "phone_number"
  | "profile_name"
  | "source_type"
  | "message_within_chat";

export const requestsDialogSearchTypeAtom =
  atomWithStorage<RequestsDialogSearchType>(
    "requests-dialog-search-type",
    "message_within_chat"
  );

export const requestsDialogSelectedSourceTypeAtom = atomWithStorage<string>(
  "requests-dialog-selected-source-type",
  "all"
);

export const requestsDialogSelectedInternalLabelAtom = atomWithStorage<string>(
  "requests-dialog-selected-internal-label",
  "all"
);

export const requestsDialogSelectedCategoryAtom = atomWithStorage<string>(
  "requests-dialog-selected-category",
  "all"
);
