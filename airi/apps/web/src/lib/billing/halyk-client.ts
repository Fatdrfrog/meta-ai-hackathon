export type HalykEpayEnv = "test" | "production";

export type HalykTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
};

export type HalykPaymentStatus =
  | "paid"
  | "failed"
  | "pending"
  | "requires_action"
  | "refunded";

export type HalykSavedCardChargeResponse = {
  id?: string;
  invoiceID?: string;
  invoiceId?: string;
  amount?: number;
  currency?: string;
  code?: string | number;
  status?: string;
  reference?: string;
  intReference?: string;
  cardID?: string;
  cardId?: string;
  issuer?: string;
  message?: string;
  secure3D?: {
    paReq?: string;
    md?: string;
    action?: string;
  } | null;
  [key: string]: unknown;
};

export type HalykPostLinkPayload = {
  invoiceId?: string;
  invoiceID?: string;
  id?: string;
  amount?: number;
  currency?: string;
  code?: string | number;
  status?: string;
  reason?: string;
  reasonCode?: string | number;
  reference?: string;
  intReference?: string;
  secret_hash?: string;
  cardId?: string;
  cardID?: string;
  cardMask?: string;
  cardType?: string;
  issuer?: string;
  terminal?: string;
  dateTime?: string;
  [key: string]: unknown;
};

export type HalykEndpoints = {
  oauthUrl: string;
  cardAuthUrl: string;
  checkStatusUrlBase: string;
  deactivateCardUrlBase: string;
  paymentJsUrl: string;
};

export function getHalykEndpoints(env: HalykEpayEnv): HalykEndpoints {
  if (env === "production") {
    return {
      oauthUrl: "https://epay-oauth.homebank.kz/oauth2/token",
      cardAuthUrl: "https://epay-api.homebank.kz/payments/cards/auth",
      checkStatusUrlBase:
        "https://epay-api.homebank.kz/check-status/payment/transaction",
      deactivateCardUrlBase: "https://epay-api.homebank.kz/card/deactivate",
      paymentJsUrl: "https://epay.homebank.kz/payform/payment-api.js",
    };
  }

  return {
    oauthUrl: "https://test-epay-oauth.epayment.kz/oauth2/token",
    cardAuthUrl: "https://test-epay-api.epayment.kz/payments/cards/auth",
    checkStatusUrlBase:
      "https://test-epay-api.epayment.kz/check-status/payment/transaction",
    deactivateCardUrlBase: "https://testepay.homebank.kz/api/card/deactivate",
    paymentJsUrl: "https://test-epay.epayment.kz/payform/payment-api.js",
  };
}

export function normalizeHalykEnv(value: unknown): HalykEpayEnv {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "production" || normalized === "prod"
    ? "production"
    : "test";
}

export function isValidHalykInvoiceId(value: unknown): boolean {
  return typeof value === "string" && /^\d{6,15}$/.test(value);
}

export function getHalykPayloadInvoiceId(
  payload: Pick<HalykPostLinkPayload, "invoiceId" | "invoiceID">
): string | null {
  const invoiceId = String(payload.invoiceId ?? payload.invoiceID ?? "").trim();
  return isValidHalykInvoiceId(invoiceId) ? invoiceId : null;
}

export function normalizeHalykPaymentStatus(
  payload:
    | HalykPostLinkPayload
    | HalykSavedCardChargeResponse
    | {
        resultCode?: string | number;
        statusName?: string | null;
        transaction?: { statusName?: string | null } | null;
      }
): HalykPaymentStatus {
  const code = (payload as { code?: unknown }).code;
  const status = String((payload as { status?: unknown }).status || "")
    .trim()
    .toUpperCase();
  const statusName = String(
    (payload as { transaction?: { statusName?: unknown } | null }).transaction
      ?.statusName ||
      (payload as { statusName?: unknown }).statusName ||
      ""
  )
    .trim()
    .toUpperCase();
  const resultCode = String(
    (payload as { resultCode?: unknown }).resultCode || ""
  ).trim();

  if (status === "3D") return "requires_action";
  if (statusName === "REFUND") return "refunded";
  if (resultCode === "102" || resultCode === "107") return "pending";
  if (resultCode && resultCode !== "100") return "failed";
  if (resultCode === "100") {
    if (statusName === "CHARGE") return "paid";
    if (["FAILED", "REJECT", "CANCEL", "CANCEL_OLD", "3D"].includes(statusName))
      return "failed";
    return "pending";
  }
  if (code === "ok" || code === 0 || code === "0") {
    return status === "CHARGE" || !status
      ? "paid"
      : status === "3D"
        ? "requires_action"
        : "pending";
  }

  return "failed";
}

export function verifyHalykTransactionStatus(
  payload: unknown,
  expected: {
    invoiceId: string;
    amount: number;
    currency: string;
    terminalId: string;
  }
): HalykPaymentStatus {
  if (!payload || typeof payload !== "object") return "pending";
  const result = payload as { resultCode?: unknown; transaction?: unknown };
  if (
    String(result.resultCode) !== "100" ||
    !result.transaction ||
    typeof result.transaction !== "object"
  )
    return "pending";
  const transaction = result.transaction as Record<string, unknown>;
  if (
    transaction.invoiceID !== expected.invoiceId ||
    typeof transaction.amount !== "number" ||
    transaction.amount !== expected.amount ||
    transaction.currency !== expected.currency ||
    transaction.terminalID !== expected.terminalId
  )
    throw new Error("Halyk transaction does not match the owned invoice");
  return normalizeHalykPaymentStatus({
    resultCode: "100",
    statusName: String(transaction.statusName || ""),
  });
}

export function buildHalykTokenFormData(params: {
  clientId: string;
  clientSecret: string;
  invoiceId?: string | null;
  amount?: number | null;
  currency?: string | null;
  terminalId?: string | null;
  postLink?: string | null;
  failurePostLink?: string | null;
  secretHash?: string | null;
  scope?: string | null;
}): FormData {
  const formData = new FormData();
  formData.set("grant_type", "client_credentials");
  formData.set("scope", params.scope || "payment");
  formData.set("client_id", params.clientId);
  formData.set("client_secret", params.clientSecret);

  if (params.invoiceId) formData.set("invoiceID", params.invoiceId);
  if (typeof params.amount === "number") {
    formData.set("amount", String(params.amount));
  }
  if (params.currency) formData.set("currency", params.currency);
  if (params.terminalId) formData.set("terminal", params.terminalId);
  if (params.postLink) formData.set("postLink", params.postLink);
  if (params.failurePostLink) {
    formData.set("failurePostLink", params.failurePostLink);
  }
  if (params.secretHash) formData.set("secret_hash", params.secretHash);

  return formData;
}

export class HalykEpayClient {
  private readonly endpoints: HalykEndpoints;

  constructor(
    private readonly config: {
      env: HalykEpayEnv;
      clientId: string;
      clientSecret: string;
      terminalId: string;
    },
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.endpoints = getHalykEndpoints(config.env);
  }

  get paymentJsUrl(): string {
    return this.endpoints.paymentJsUrl;
  }

  async requestToken(params: {
    invoiceId?: string | null;
    amount?: number | null;
    currency?: string | null;
    postLink?: string | null;
    failurePostLink?: string | null;
    secretHash?: string | null;
    scope?: string | null;
  }): Promise<HalykTokenResponse> {
    const response = await this.fetcher(this.endpoints.oauthUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      body: buildHalykTokenFormData({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        terminalId: this.config.terminalId,
        invoiceId: params.invoiceId,
        amount: params.amount,
        currency: params.currency,
        postLink: params.postLink,
        failurePostLink: params.failurePostLink,
        secretHash: params.secretHash,
        scope: params.scope,
      }),
    });

    const payload = (await response
      .json()
      .catch(() => null)) as Partial<HalykTokenResponse> | null;
    if (!response.ok || !payload?.access_token) {
      throw new Error("Failed to request Halyk ePay token");
    }

    return {
      access_token: payload.access_token,
      expires_in: Number(payload.expires_in || 0),
      refresh_token: payload.refresh_token || "",
      scope: payload.scope || params.scope || "payment",
      token_type: payload.token_type || "Bearer",
    };
  }

  async chargeSavedCard(params: {
    invoiceId: string;
    amount: number;
    currency: string;
    description: string;
    accountId: string;
    cardId: string;
    postLink: string;
    failurePostLink: string;
    backLink: string;
    failureBackLink: string;
    email?: string | null;
    phone?: string | null;
  }): Promise<HalykSavedCardChargeResponse> {
    const token = await this.requestToken({
      invoiceId: params.invoiceId,
      amount: params.amount,
      currency: params.currency,
      postLink: params.postLink,
      failurePostLink: params.failurePostLink,
      scope: "payment",
    });

    const response = await this.fetcher(this.endpoints.cardAuthUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        terminalId: this.config.terminalId,
        invoiceId: params.invoiceId,
        description: params.description.slice(0, 125),
        accountId: params.accountId,
        email: params.email || "",
        phone: params.phone || "",
        backLink: params.backLink,
        failureBackLink: params.failureBackLink,
        postLink: params.postLink,
        failurePostLink: params.failurePostLink,
        language: "eng",
        paymentType: "cardId",
        recurrent: true,
        cardId: {
          id: params.cardId,
        },
      }),
    });

    const payload = (await response
      .json()
      .catch(() => null)) as HalykSavedCardChargeResponse | null;
    if (!response.ok || !payload) {
      throw new Error("Failed to charge saved Halyk card");
    }

    return payload;
  }

  async checkTransactionStatus(invoiceId: string) {
    const token = await this.requestToken({
      scope:
        "webapi usermanagement email_send verification statement statistics payment",
    });
    const response = await this.fetcher(
      `${this.endpoints.checkStatusUrlBase}/${encodeURIComponent(invoiceId)}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      }
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new Error("Failed to check Halyk transaction status");
    }

    return payload;
  }

  async deactivateCard(cardId: string): Promise<{ status?: string }> {
    const token = await this.requestToken({
      scope:
        "webapi usermanagement email_send statement verification payment statistics",
    });
    const response = await this.fetcher(
      `${this.endpoints.deactivateCardUrlBase}/${encodeURIComponent(cardId)}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      }
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new Error("Failed to deactivate Halyk card");
    }

    return payload as { status?: string };
  }
}
