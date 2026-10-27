"use client";

import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { panelConnectWhatsAppOnboardingHref } from "@/features/panel/shared/routing/hrefs";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  ArrowRight,
  Building2,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { saveSetupProfile } from "./actions";
import { captureOnboardingAnalytics } from "./onboarding-analytics";
import type { ProductTrainingHandoffState } from "./product-context-state";
import { ProductContextStep } from "./product-context-step";
import {
  SetupRequiredStep,
  SIGNUP_REFERRAL_OTHER_VALUE,
} from "./setup-required-step";
import { SetupStepRail, StepSectionHeader } from "./setup-step-rail";
import {
  createInitialSetupWizardState,
  setupWizardReducer,
  type SetupStep,
  type SetupWizardAction,
  type SetupWizardState,
} from "./setup-wizard-state";

type SetupWizardProps = {
  initialFullName: string;
  initialWorkspaceId?: string;
  initialStep?: SetupStep;
  requiresProfile: boolean;
  requiresWorkspace: boolean;
};

type AdoptedWorkspaceSession = {
  workspaceId: string;
  sessionKey: string;
};

const INITIAL_PRODUCT_HANDOFF: ProductTrainingHandoffState = {
  mutationPending: false,
  started: false,
  ready: false,
  background: false,
};

type SetupTextField = Extract<
  SetupWizardAction,
  { type: "text_changed" }
>["field"];

async function readCompanyCreationResponse(
  response: Response,
  messages: { unknownError: string; httpError: string }
): Promise<{ workspaceId: string }> {
  let result: { success?: boolean; workspaceId?: string; error?: unknown };
  try {
    result = await response.json();
  } catch {
    throw new Error(messages.unknownError);
  }

  if (!response.ok) {
    if (response.status >= 500) throw new Error(messages.unknownError);
    throw new Error(
      (typeof result.error === "string" && result.error) ||
        `${messages.httpError} ${response.status}`
    );
  }
  if (!result.success || !result.workspaceId) {
    throw new Error(messages.unknownError);
  }
  return { workspaceId: result.workspaceId };
}

function useSetupWizardSessionBoundary(initialWorkspaceId?: string) {
  const incomingWorkspaceId = initialWorkspaceId ?? "";
  const naturalSessionKey = `setup-session:${incomingWorkspaceId || "new"}`;
  const [adoptedSession, setAdoptedSession] =
    useState<AdoptedWorkspaceSession | null>(null);
  const sessionKey =
    adoptedSession?.workspaceId === incomingWorkspaceId
      ? adoptedSession.sessionKey
      : naturalSessionKey;
  const onWorkspaceAdopted = useCallback(
    (workspaceId: string) => {
      if (!workspaceId) return false;
      if (incomingWorkspaceId && incomingWorkspaceId !== workspaceId) {
        return false;
      }
      if (incomingWorkspaceId === workspaceId) return true;
      setAdoptedSession(current => {
        if (
          current?.workspaceId === workspaceId &&
          current.sessionKey === sessionKey
        ) {
          return current;
        }
        return { workspaceId, sessionKey };
      });
      return true;
    },
    [incomingWorkspaceId, sessionKey]
  );

  return { sessionKey, onWorkspaceAdopted };
}

function useSetupWizardSessionIsActive() {
  const activeRef = useRef(true);
  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  return useCallback(() => activeRef.current, []);
}

function failSetupSubmission(
  dispatch: React.Dispatch<SetupWizardAction>,
  isSessionActive: () => boolean,
  error: unknown,
  fallback: string
) {
  if (!isSessionActive()) return;
  dispatch({
    type: "submission_failed",
    error: error instanceof Error ? error.message : fallback,
  });
}

function finishSetupSubmission(
  dispatch: React.Dispatch<SetupWizardAction>,
  isSessionActive: () => boolean,
  submitInFlightRef: { current: boolean }
) {
  submitInFlightRef.current = false;
  if (isSessionActive()) dispatch({ type: "submission_finished" });
}

function assertSetupSessionActive(isSessionActive: () => boolean) {
  if (!isSessionActive()) throw new Error("Obsolete setup session");
}

type SetupWizardViewProps = {
  state: SetupWizardState;
  hasWorkspaceSetup: boolean;
  requiresProfile: boolean;
  requiresWorkspace: boolean;
  requiredStepComplete: boolean;
  isRequiredFormReady: boolean;
  productMutationPending: boolean;
  formRef: React.RefObject<HTMLFormElement | null>;
  requiredHeadingRef: React.RefObject<HTMLHeadingElement | null>;
  productHeadingRef: React.RefObject<HTMLHeadingElement | null>;
  onSubmit(event: React.FormEvent<HTMLFormElement>): void | Promise<void>;
  onStepChange(step: SetupStep): void;
  onTextChange(field: SetupTextField, value: string): void;
  onPrivacyChange(value: boolean): void;
  onProductHandoffStateChange(state: ProductTrainingHandoffState): void;
};

export function SetupWizard(props: SetupWizardProps) {
  const { sessionKey, onWorkspaceAdopted } = useSetupWizardSessionBoundary(
    props.initialWorkspaceId
  );

  return (
    <SetupWizardSession
      key={sessionKey}
      {...props}
      onWorkspaceAdopted={onWorkspaceAdopted}
    />
  );
}

function SetupWizardSession({
  initialFullName,
  initialWorkspaceId,
  initialStep = "required",
  requiresProfile,
  requiresWorkspace,
  onWorkspaceAdopted,
}: SetupWizardProps & { onWorkspaceAdopted(workspaceId: string): boolean }) {
  const tCompany = useTranslations("AddCompanyForm");
  const unknownError = tCompany("unknownError");
  const router = useRouter();
  const isSessionActive = useSetupWizardSessionIsActive();
  const [state, dispatch] = useReducer(
    setupWizardReducer,
    {
      initialFullName,
      initialWorkspaceId,
      initialStep,
      requiresProfile,
    },
    createInitialSetupWizardState
  );
  const [productHandoff, setProductHandoff] =
    useState<ProductTrainingHandoffState>(INITIAL_PRODUCT_HANDOFF);
  const formRef = useRef<HTMLFormElement>(null);
  const submitInFlightRef = useRef(false);
  const handoffCommittedRef = useRef(false);
  const focusOnNextStepRef = useRef(false);
  const requiredHeadingRef = useRef<HTMLHeadingElement>(null);
  const productHeadingRef = useRef<HTMLHeadingElement>(null);
  const hasWorkspaceSetup = requiresWorkspace || Boolean(state.workspaceId);
  const requiredStepComplete = Boolean(state.workspaceId) && state.profileSaved;

  const isRequiredFormReady =
    (!requiresProfile ||
      state.profileSaved ||
      state.fullName.trim().length > 0) &&
    (!requiresWorkspace ||
      (state.companyName.trim().length > 0 &&
        (Boolean(state.workspaceId) || state.acceptedPrivacy)));

  useEffect(() => {
    if (!focusOnNextStepRef.current) return;

    focusOnNextStepRef.current = false;
    const heading =
      state.activeStep === "product"
        ? productHeadingRef.current
        : requiredHeadingRef.current;
    heading?.focus();
  }, [state.activeStep]);

  const replaceWithProductResumeUrl = useCallback(
    (workspaceId: string) => {
      router.replace(
        `/setup?step=train&workspaceId=${encodeURIComponent(workspaceId)}`
      );
    },
    [router]
  );

  const advanceToProduct = useCallback(
    (workspaceId: string) => {
      if (!isSessionActive() || !onWorkspaceAdopted(workspaceId)) return;
      focusOnNextStepRef.current = true;
      dispatch({ type: "step_changed", step: "product" });
      replaceWithProductResumeUrl(workspaceId);
    },
    [isSessionActive, onWorkspaceAdopted, replaceWithProductResumeUrl]
  );

  const handleStepChange = useCallback(
    (step: SetupStep) => {
      if (productHandoff.mutationPending) return;
      if (step === state.activeStep) return;
      if (step === "product" && !requiredStepComplete) return;

      focusOnNextStepRef.current = true;
      dispatch({ type: "step_changed", step });
      if (step === "product" && state.workspaceId) {
        replaceWithProductResumeUrl(state.workspaceId);
      }
    },
    [
      productHandoff.mutationPending,
      replaceWithProductResumeUrl,
      requiredStepComplete,
      state.activeStep,
      state.workspaceId,
    ]
  );

  const handleTextChange = useCallback(
    (field: SetupTextField, value: string) => {
      dispatch({ type: "text_changed", field, value });
    },
    []
  );
  const handlePrivacyChange = useCallback((value: boolean) => {
    dispatch({ type: "privacy_changed", value });
  }, []);

  const persistProfileIfNeeded = async (): Promise<boolean> => {
    if (!isSessionActive()) return false;
    if (!requiresProfile || state.profileSaved) return true;

    const profileResult = await saveSetupProfile(state.fullName);
    assertSetupSessionActive(isSessionActive);
    if (!profileResult.success) {
      throw new Error(
        profileResult.error || "Failed to update profile. Please try again."
      );
    }
    dispatch({ type: "profile_saved" });
    return true;
  };

  const createWorkspaceAndAdvance = async () => {
    if (!isRequiredFormReady) {
      formRef.current?.reportValidity();
      return;
    }

    if (state.workspaceId) {
      if (!requiresProfile || state.profileSaved) {
        advanceToProduct(state.workspaceId);
        return;
      }

      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      dispatch({ type: "submission_started" });

      try {
        if (!(await persistProfileIfNeeded())) return;
        advanceToProduct(state.workspaceId);
      } catch (error) {
        failSetupSubmission(dispatch, isSessionActive, error, unknownError);
      } finally {
        finishSetupSubmission(dispatch, isSessionActive, submitInFlightRef);
      }
      return;
    }

    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    dispatch({ type: "submission_started" });

    try {
      if (!(await persistProfileIfNeeded())) return;

      const normalizedReferralSource =
        state.referralSource === SIGNUP_REFERRAL_OTHER_VALUE
          ? state.referralSourceOther.trim()
          : state.referralSource.trim();
      const response = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: state.companyName,
          ...(state.phone.trim() ? { phone: state.phone.trim() } : {}),
          ...(normalizedReferralSource
            ? { signup_referral_source: normalizedReferralSource }
            : {}),
          accepted_privacy: state.acceptedPrivacy,
        }),
      });
      const result = await readCompanyCreationResponse(response, {
        unknownError: tCompany("unknownError"),
        httpError: tCompany("httpError"),
      });
      assertSetupSessionActive(isSessionActive);

      dispatch({ type: "workspace_created", workspaceId: result.workspaceId });
      captureOnboardingAnalytics({
        workspaceId: result.workspaceId,
        event: "onboarding_step_completed",
        stepId: "workspace_created",
        metadata: {
          source: "self_signup",
          has_website: false,
          has_signup_referral_source: Boolean(normalizedReferralSource),
        },
      });
      advanceToProduct(result.workspaceId);
    } catch (error) {
      failSetupSubmission(dispatch, isSessionActive, error, unknownError);
    } finally {
      finishSetupSubmission(dispatch, isSessionActive, submitInFlightRef);
    }
  };

  const finishWorkspaceSetup = () => {
    if (!isSessionActive()) return;
    if (!state.workspaceId) {
      dispatch({
        type: "submission_failed",
        error: tCompany("unknownError"),
      });
      return;
    }
    if (handoffCommittedRef.current) return;

    handoffCommittedRef.current = true;

    captureOnboardingAnalytics({
      workspaceId: state.workspaceId,
      event: "onboarding_step_completed",
      stepId: "integrations_handoff",
      metadata: {
        training_started: productHandoff.started,
        training_ready: productHandoff.ready,
        training_background: productHandoff.background,
      },
    });
    router.replace(panelConnectWhatsAppOnboardingHref(state.workspaceId));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isSessionActive()) return;

    if (state.activeStep === "product" && productHandoff.mutationPending) {
      return;
    }

    if (hasWorkspaceSetup) {
      if (state.activeStep === "required") {
        await createWorkspaceAndAdvance();
      } else {
        finishWorkspaceSetup();
      }
      return;
    }

    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    dispatch({ type: "submission_started" });

    try {
      if (!(await persistProfileIfNeeded())) return;
      router.push("/onboarding");
      router.refresh();
    } catch (error) {
      failSetupSubmission(dispatch, isSessionActive, error, unknownError);
    } finally {
      finishSetupSubmission(dispatch, isSessionActive, submitInFlightRef);
    }
  };

  return (
    <SetupWizardView
      state={state}
      hasWorkspaceSetup={hasWorkspaceSetup}
      requiresProfile={requiresProfile}
      requiresWorkspace={requiresWorkspace}
      requiredStepComplete={requiredStepComplete}
      isRequiredFormReady={isRequiredFormReady}
      productMutationPending={productHandoff.mutationPending}
      formRef={formRef}
      requiredHeadingRef={requiredHeadingRef}
      productHeadingRef={productHeadingRef}
      onSubmit={handleSubmit}
      onStepChange={handleStepChange}
      onTextChange={handleTextChange}
      onPrivacyChange={handlePrivacyChange}
      onProductHandoffStateChange={setProductHandoff}
    />
  );
}

function SetupWizardView({
  state,
  hasWorkspaceSetup,
  requiresProfile,
  requiresWorkspace,
  requiredStepComplete,
  isRequiredFormReady,
  productMutationPending,
  formRef,
  requiredHeadingRef,
  productHeadingRef,
  onSubmit,
  onStepChange,
  onTextChange,
  onPrivacyChange,
  onProductHandoffStateChange,
}: SetupWizardViewProps) {
  const tProfile = useTranslations("FinishProfilePage");
  const tCompany = useTranslations("AddCompanyForm");
  const title = hasWorkspaceSetup
    ? state.activeStep === "product"
      ? tCompany("productStepTitle")
      : tCompany("registerCompany")
    : tProfile("title");
  const description = hasWorkspaceSetup
    ? state.activeStep === "product"
      ? tCompany("productStepDescription")
      : tCompany("lastStepDescription")
    : tProfile("description");
  const requiredSubmitLabel = requiresWorkspace
    ? tCompany("registerCompanyButton")
    : tProfile("continueButton");
  const primaryButtonLabel = !hasWorkspaceSetup
    ? requiredSubmitLabel
    : state.activeStep === "required"
      ? tCompany("continueToProductStep")
      : tCompany("continueToIntegrations");
  const isProductStep = hasWorkspaceSetup && state.activeStep === "product";
  const primaryButtonDisabled = isProductStep
    ? productMutationPending
    : state.isLoading ||
      (hasWorkspaceSetup &&
        state.activeStep === "required" &&
        !isRequiredFormReady);

  return (
    <div className="flex h-dvh items-start justify-center overflow-y-auto bg-linear-to-br from-[#fec8e7]/30 via-[#e7c9ff]/20 to-[#cfffe1]/30 px-3 py-3 [scrollbar-gutter:stable] dark:from-[#201025] dark:via-[#131124] dark:to-[#0f2019] sm:p-6">
      <Card className="w-full max-w-2xl overflow-hidden rounded-[2.5rem] border-4 border-foreground bg-card text-card-foreground shadow-[8px_8px_0px_#000000] transition-all dark:shadow-[8px_8px_0px_rgba(255,255,255,0.15)]">
        <CardHeader className="relative border-b-4 border-foreground bg-[#fdf0a6] px-5 py-4 pr-16 text-black dark:bg-yellow-950/40 dark:text-foreground sm:px-6 sm:py-5">
          <div className="absolute top-3 right-3 flex items-center justify-center rounded-xl border-2 border-foreground bg-background p-0.5 shadow-[2px_2px_0px_#000000] sm:top-4 sm:right-4">
            <LanguageSwitcher menuPortalled={false} />
          </div>
          <h1 className="break-words text-xl font-black leading-tight sm:text-2xl">
            {title}
          </h1>
          <CardDescription className="max-w-xl break-words text-sm font-bold leading-6 text-black/70 dark:text-foreground/80">
            {description}
          </CardDescription>
        </CardHeader>
        <form ref={formRef} onSubmit={onSubmit}>
          <CardContent className="space-y-6 px-5 py-5 sm:px-6">
            {hasWorkspaceSetup ? (
              <div className="space-y-5">
                <SetupStepRail
                  activeStep={state.activeStep}
                  canReturnToRequired={requiresWorkspace}
                  navigationDisabled={productMutationPending}
                  requiredStepComplete={requiredStepComplete}
                  workspaceId={state.workspaceId}
                  onStepChange={onStepChange}
                />
                {state.activeStep === "required" ? (
                  <div className="space-y-6">
                    <StepSectionHeader
                      headingRef={requiredHeadingRef}
                      icon={
                        <Building2 className="h-4 w-4" aria-hidden="true" />
                      }
                      step={tCompany("stepLabel", { number: "1" })}
                      title={tCompany("requiredStepTitle")}
                      badge={tCompany("requiredBadge")}
                      description={tCompany("requiredStepDescription")}
                      variant="required"
                    />
                    <SetupRequiredStep
                      state={state}
                      requiresProfile={requiresProfile}
                      requiresWorkspace={requiresWorkspace}
                      profileFieldsLocked={state.profileSaved}
                      workspaceFieldsLocked={Boolean(state.workspaceId)}
                      onTextChange={onTextChange}
                      onPrivacyChange={onPrivacyChange}
                    />
                  </div>
                ) : (
                  <div className="space-y-5">
                    <StepSectionHeader
                      headingRef={productHeadingRef}
                      icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
                      step={tCompany("stepLabel", { number: "2" })}
                      title={tCompany("productStepTitle")}
                      badge={tCompany("productBadge")}
                      description={tCompany("productStepDescription")}
                      variant="product"
                    />
                    {state.workspaceId ? (
                      <ProductContextStep
                        workspaceId={state.workspaceId}
                        onHandoffStateChange={onProductHandoffStateChange}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            ) : (
              <SetupRequiredStep
                state={state}
                requiresProfile={requiresProfile}
                requiresWorkspace={requiresWorkspace}
                profileFieldsLocked={state.profileSaved}
                workspaceFieldsLocked={Boolean(state.workspaceId)}
                onTextChange={onTextChange}
                onPrivacyChange={onPrivacyChange}
              />
            )}

            {state.error ? (
              <Alert className="border-[3px] border-foreground rounded-2xl shadow-[3px_3px_0px_#000000] bg-destructive/10 text-destructive font-semibold">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter
            className={cn(
              "border-t-4 border-foreground bg-muted/20 px-5 py-4 sm:px-6",
              isProductStep && "justify-end"
            )}
          >
            <Button
              type="submit"
              size={isProductStep ? "sm" : "default"}
              disabled={primaryButtonDisabled}
              className={
                isProductStep
                  ? "w-full max-w-full sm:w-auto sm:min-w-36 [&_.btn-push-front]:min-w-0 [&_.btn-push-front]:px-4 [&_.btn-push-front]:text-center [&_.btn-push-front]:whitespace-normal"
                  : "w-full"
              }
            >
              {state.isLoading && !isProductStep ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {tCompany("creating")}
                </span>
              ) : (
                primaryButtonLabel
              )}
              {!state.isLoading || isProductStep ? (
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              ) : null}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
