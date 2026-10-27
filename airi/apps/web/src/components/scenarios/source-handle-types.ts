export type ScenarioSourceHandleCreatePoint = {
  clientX: number;
  clientY: number;
};

export type ScenarioOptionBranchHandleLayout = {
  /** Hang on the current card/row instead of the outer node border. */
  local?: boolean;
};

export type ScenarioSourceHandlePresentation = {
  chooseLabel: string;
  unlinkedStatus: string;
  /** Precedes the next step's name, as "Next:". */
  linkedPrefix: string;
  /** A linked route whose next step has no name; falls back to `linkedPrefix`. */
  connectedStatus?: string;
  /** An unlinked route that must be linked; falls back to `unlinkedStatus`. */
  requiredStatus?: string;
  destinationsBySourceHandle?: ReadonlyMap<
    string,
    { nodeId: string; label: string }
  >;
};
