/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";
import useSWR from "swr";
import { EmailProviderConfigForm } from "./email-provider-config-form";

jest.mock("swr", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

const translations: Record<string, string> = {
  providerTitle: "Company email",
  providerDescriptionPlatform: "Send product emails from your own address.",
  readOnlyHint:
    "You can view email setup, but only workspace admins can change it.",
  statusConnected: "Email is ready",
  statusPendingDns: "Add domain records",
  statusError: "Setup needs attention",
  statusDisconnected: "Not set up",
  statusSettingUp: "Setting up",
  statusChecking: "Checking",
  defaultFromAddress: "Sender email",
  defaultFromAddressPlaceholder: "hello@yourcompany.com",
  connectWithPostmark: "Set up email",
  verifyDnsNow: "Check again",
  verifyingDns: "Checking...",
  providerSaving: "Setting up...",
  pendingDnsDescription:
    "Add these records at your domain host, then check again.",
  readyDescription: "Email is ready.",
  errorDescription: "We could not finish setup. Try again.",
  dnsRecordType: "Type",
  dnsRecordName: "Name",
  dnsRecordValue: "Value",
  dnsTxtRecord: "TXT",
  dnsCnameRecord: "CNAME",
  copy: "Copy",
  valueCopied: "Value copied",
  copyFailed: "Failed to copy",
  advancedSetupTitle: "Advanced setup",
  advancedDescription: "Use this only if your team manages Postmark manually.",
  postmarkServerToken: "Postmark server token",
  postmarkServerTokenPlaceholder: "pm_...",
  tokenRequiredHint: "Required for manual setup.",
  tokenUpdateHint: "Leave empty to keep the current token.",
  saveProvider: "Save provider",
  providerSaved: "Provider settings saved",
  platformSetupSuccess: "Email setup started",
  dnsVerifySuccess: "Email status checked",
};

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => translations[key] ?? key,
}));

const useSWRMock = useSWR as jest.Mock;

const pendingManagedState = {
  domain: "example.com",
  verificationStatus: "pending_dns",
  dkimVerified: false,
  returnPathVerified: false,
  dns: {
    dkimHost: "20260218130527pm._domainkey.example.com",
    dkimValue: "txt-record-value",
    returnPathHost: "pm-bounces.example.com",
    returnPathValue: "pm.mtasv.net",
  },
};

function renderForm(provider: unknown) {
  useSWRMock.mockReturnValue({
    data: {
      provider,
      permissions: { canManage: true },
    },
    isLoading: false,
    mutate: jest.fn(),
  });

  render(
    <EmailProviderConfigForm
      workspaceId="workspace_1"
      emailProviderStatus={provider ? "pending_dns" : "disconnected"}
    />
  );
}

describe("EmailProviderConfigForm", () => {
  beforeEach(() => {
    useSWRMock.mockReset();
  });

  it("shows non-technical copy in the default setup path", () => {
    renderForm(null);

    expect(screen.getByText("Company email")).toBeInTheDocument();
    expect(
      screen.getByText("Send product emails from your own address.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Sender email")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set up email" })
    ).toBeInTheDocument();
  });

  it("hides Postmark internals from the default setup path", () => {
    renderForm(null);

    expect(screen.queryByText("Get server token")).not.toBeInTheDocument();
    expect(screen.queryByText("Message streams")).not.toBeInTheDocument();
    expect(screen.queryByText("Webhooks setup")).not.toBeInTheDocument();
    expect(screen.queryByText("Outbound webhook URL")).not.toBeInTheDocument();
  });

  it("resumes pending setup without exposing webhook or DKIM labels", () => {
    renderForm({
      id: "provider_1",
      workspaceId: "workspace_1",
      provider: "postmark",
      mode: "platform_managed",
      verificationStatus: "pending_dns",
      status: "inactive",
      defaultFromAddress: "hello@example.com",
      webhookUrl: "https://app.example.com/api/email/outbound?token=secret",
      managedState: pendingManagedState,
      permissions: { canManage: true },
    });

    expect(screen.getByText("Add domain records")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add these records at your domain host, then check again."
      )
    ).toBeInTheDocument();

    const records = screen.getByTestId("email-domain-records");
    expect(within(records).getAllByText("TXT")).toHaveLength(1);
    expect(within(records).getAllByText("CNAME")).toHaveLength(1);
    expect(
      screen.queryByText(
        "https://app.example.com/api/email/outbound?token=secret"
      )
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/DKIM/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Return-Path/i)).not.toBeInTheDocument();
  });

  it("shows the ready state when the provider is verified", () => {
    renderForm({
      id: "provider_1",
      workspaceId: "workspace_1",
      provider: "postmark",
      mode: "platform_managed",
      verificationStatus: "verified",
      status: "active",
      defaultFromAddress: "hello@example.com",
      webhookUrl: "https://app.example.com/api/email/outbound?token=secret",
      managedState: {
        ...pendingManagedState,
        verificationStatus: "verified",
        dkimVerified: true,
        returnPathVerified: true,
      },
      permissions: { canManage: true },
    });

    expect(screen.getByText("Email is ready.")).toBeInTheDocument();
    expect(
      screen.queryByTestId("email-domain-records")
    ).not.toBeInTheDocument();
  });
});
