type EmailAutomationNavPayload = {
  emailProviderConnected?: boolean;
  emailSources?: unknown[];
};

export function shouldShowEmailAutomationNav(
  payload: EmailAutomationNavPayload
): boolean {
  return payload.emailProviderConnected === true;
}
