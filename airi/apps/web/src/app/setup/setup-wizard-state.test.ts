import {
  setupWizardReducer,
  type SetupWizardState,
} from "./setup-wizard-state";

const initialState: SetupWizardState = {
  fullName: "Ada",
  companyName: "Acme",
  phone: "",
  referralSource: "",
  referralSourceOther: "",
  acceptedPrivacy: false,
  profileSaved: false,
  workspaceId: "",
  activeStep: "required",
  isLoading: false,
  error: null,
};

describe("setupWizardReducer", () => {
  it("updates text fields immutably without disturbing sibling form state", () => {
    const nextState = setupWizardReducer(initialState, {
      type: "text_changed",
      field: "phone",
      value: "+7 701 234 56 78",
    });

    expect(nextState).not.toBe(initialState);
    expect(nextState).toEqual({
      ...initialState,
      phone: "+7 701 234 56 78",
    });
    expect(initialState.phone).toBe("");
  });

  it("tracks privacy and submission lifecycle state", () => {
    const privacyAccepted = setupWizardReducer(initialState, {
      type: "privacy_changed",
      value: true,
    });
    const started = setupWizardReducer(privacyAccepted, {
      type: "submission_started",
    });
    const failed = setupWizardReducer(started, {
      type: "submission_failed",
      error: "Could not save",
    });
    const finished = setupWizardReducer(failed, {
      type: "submission_finished",
    });

    expect(started).toMatchObject({
      acceptedPrivacy: true,
      isLoading: true,
      error: null,
    });
    expect(failed.error).toBe("Could not save");
    expect(finished.isLoading).toBe(false);
  });

  it("records profile, workspace, and product-step transitions", () => {
    const profileSaved = setupWizardReducer(initialState, {
      type: "profile_saved",
    });
    const workspaceCreated = setupWizardReducer(profileSaved, {
      type: "workspace_created",
      workspaceId: "workspace-1",
    });
    const productStep = setupWizardReducer(workspaceCreated, {
      type: "step_changed",
      step: "product",
    });

    expect(profileSaved.profileSaved).toBe(true);
    expect(workspaceCreated.workspaceId).toBe("workspace-1");
    expect(productStep.activeStep).toBe("product");
  });

  it("rejects a synthetic product transition until the required profile is saved", () => {
    const incompleteExistingWorkspace = {
      ...initialState,
      workspaceId: "workspace-1",
    };

    expect(
      setupWizardReducer(incompleteExistingWorkspace, {
        type: "step_changed",
        step: "product",
      })
    ).toBe(incompleteExistingWorkspace);

    const profileSaved = setupWizardReducer(incompleteExistingWorkspace, {
      type: "profile_saved",
    });
    expect(
      setupWizardReducer(profileSaved, {
        type: "step_changed",
        step: "product",
      }).activeStep
    ).toBe("product");
  });
});
