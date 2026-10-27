export type SetupStep = "required" | "product";

export type SetupWizardState = {
  fullName: string;
  companyName: string;
  phone: string;
  referralSource: string;
  referralSourceOther: string;
  acceptedPrivacy: boolean;
  profileSaved: boolean;
  workspaceId: string;
  activeStep: SetupStep;
  isLoading: boolean;
  error: string | null;
};

export type SetupWizardAction =
  | {
      type: "text_changed";
      field:
        | "fullName"
        | "companyName"
        | "phone"
        | "referralSource"
        | "referralSourceOther";
      value: string;
    }
  | { type: "privacy_changed"; value: boolean }
  | { type: "submission_started" }
  | { type: "submission_failed"; error: string }
  | { type: "submission_finished" }
  | { type: "profile_saved" }
  | { type: "workspace_created"; workspaceId: string }
  | { type: "step_changed"; step: SetupStep };

export function createInitialSetupWizardState(params: {
  initialFullName: string;
  initialWorkspaceId?: string;
  initialStep: SetupStep;
  requiresProfile: boolean;
}): SetupWizardState {
  const workspaceId = params.initialWorkspaceId ?? "";
  const profileSaved = !params.requiresProfile;

  return {
    fullName: params.initialFullName,
    companyName: "",
    phone: "",
    referralSource: "",
    referralSourceOther: "",
    acceptedPrivacy: false,
    profileSaved,
    workspaceId,
    activeStep:
      params.initialStep === "product" && workspaceId && profileSaved
        ? "product"
        : "required",
    isLoading: false,
    error: null,
  };
}

export function setupWizardReducer(
  state: SetupWizardState,
  action: SetupWizardAction
): SetupWizardState {
  switch (action.type) {
    case "text_changed":
      return { ...state, [action.field]: action.value };
    case "privacy_changed":
      return { ...state, acceptedPrivacy: action.value };
    case "submission_started":
      return { ...state, isLoading: true, error: null };
    case "submission_failed":
      return { ...state, error: action.error };
    case "submission_finished":
      return { ...state, isLoading: false };
    case "profile_saved":
      return { ...state, profileSaved: true };
    case "workspace_created":
      return { ...state, workspaceId: action.workspaceId };
    case "step_changed":
      if (
        action.step === "product" &&
        (!state.workspaceId || !state.profileSaved)
      ) {
        return state;
      }
      return { ...state, activeStep: action.step };
  }
}
