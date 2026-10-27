/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import LoginForm from "./LoginForm";
import { installMatchMedia } from "@/test-support/dom-test-utils";

const replaceMock = jest.fn();
const loginMock = jest.fn();
const signupMock = jest.fn();
const signInWithOAuthMock = jest.fn();
const sendMagicLinkMock = jest.fn();
const resendSignupConfirmationMock = jest.fn();
let searchParams = new URLSearchParams();
let mockLocale = "en";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, refresh: jest.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => searchParams,
}));

jest.mock("@/app/actions", () => ({ setLocale: jest.fn() }));
jest.mock("@/components/landing/landing-display-font", () => ({
  landingDisplayFont: { variable: "landing-display-font" },
}));

jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: (namespace: string) => {
    const catalog = jest.requireActual(`../../../messages/${mockLocale}.json`);
    const messages = namespace
      .split(".")
      .reduce((value, key) => value[key], catalog);
    return (key: string, values?: Record<string, string | number>) => {
      const message = messages[key] ?? key;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        message
      );
    };
  },
}));

jest.mock("@/components/auth/forgot-password-dialog", () => ({
  ForgotPasswordDialog: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock("@/components/landing/landing-light-theme", () => ({
  LandingLightTheme: () => null,
}));

jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: signInWithOAuthMock,
    },
  }),
}));

jest.mock("@/app/auth/send-magic-link/actions", () => ({
  sendMagicLink: (...args: unknown[]) => sendMagicLinkMock(...args),
}));

jest.mock("./actions", () => ({
  login: (...args: unknown[]) => loginMock(...args),
  resendSignupConfirmation: (...args: unknown[]) =>
    resendSignupConfirmationMock(...args),
  signup: (...args: unknown[]) => signupMock(...args),
}));

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

beforeEach(() => {
  mockLocale = "en";
});

describe("LoginForm signup and sign-in controls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
    signInWithOAuthMock.mockResolvedValue({ error: null });
    sendMagicLinkMock.mockResolvedValue({ success: true });
    window.history.replaceState(null, "", "/login");
    installMatchMedia();
  });

  it("lets keyboard users reveal the signup password and announces its state", async () => {
    searchParams = new URLSearchParams("tab=signup");
    const user = userEvent.setup();
    render(<LoginForm />);

    const password = screen.getByLabelText("Password");
    password.focus();
    await user.tab();
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.keyboard(" ");
    expect(password).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Hide password" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("associates the signup password requirement and enforces it only for signup", () => {
    searchParams = new URLSearchParams("tab=signup");
    const { unmount } = render(<LoginForm />);
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("minlength", "6");
    expect(password).toHaveAccessibleDescription("At least 6 characters");
    unmount();
    searchParams = new URLSearchParams();
    render(<LoginForm />);
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("minlength");
  });

  it("offers returning users a sign-in action that keeps their email and destination", async () => {
    searchParams = new URLSearchParams(
      "tab=signup&next=%2Fpanel%2Fw%2Fworkspace-1%2Fscenarios"
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    expect(screen.getByText("Already have an account?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create Account" })).toBeVisible();
    await user.type(screen.getByLabelText("Email"), "returning@example.com");
    await user.type(screen.getByLabelText("Password"), "unused-signup-password");
    const signIn = screen.getByRole("button", { name: "Sign In", exact: true });
    expect(signIn).toHaveAttribute("type", "button");
    signIn.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("tab", { name: "Sign In" })).toHaveAttribute(
      "aria-selected", "true"
    );
    expect(screen.getByLabelText("Email")).toHaveValue("returning@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveFocus();
    expect(replaceMock).toHaveBeenCalledWith(
      "/login?next=%2Fpanel%2Fw%2Fworkspace-1%2Fscenarios"
    );
    expect(loginMock).not.toHaveBeenCalled();
    expect(signupMock).not.toHaveBeenCalled();
  });

  it("focuses email when a returning user switches to sign-in before entering an address", async () => {
    searchParams = new URLSearchParams("tab=signup");
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByRole("button", { name: "Sign In", exact: true }));
    expect(screen.getByLabelText("Email")).toHaveFocus();
  });

  it("preserves the latest edited email through tab changes instead of restoring the URL email", async () => {
    searchParams = new URLSearchParams("tab=signup&email=old%40example.com");
    const user = userEvent.setup();
    const { rerender } = render(<LoginForm />);
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "corrected@example.com");
    await user.click(screen.getByRole("tab", { name: "Sign In" }));
    searchParams = new URLSearchParams();
    rerender(<LoginForm />);
    expect(screen.getByLabelText("Email")).toHaveValue("corrected@example.com");

    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "latest@example.com");
    await user.click(screen.getByRole("tab", { name: "Sign Up" }));
    searchParams = new URLSearchParams("tab=signup");
    rerender(<LoginForm />);
    expect(screen.getByLabelText("Email")).toHaveValue("latest@example.com");
  });

  it.each([
    ["en", "Show password", "Change language"],
    ["ru", "Показать пароль", "Сменить язык"],
    ["kz", "Құпия сөзді көрсету", "Тілді өзгерту"],
  ])(
    "localizes signup controls in %s",
    (locale, showPassword, changeLanguage) => {
      mockLocale = locale;
      searchParams = new URLSearchParams("tab=signup");
      render(<LoginForm />);
      expect(
        screen.getByRole("button", { name: showPassword })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: changeLanguage })
      ).toBeInTheDocument();
    }
  );

  it("shows a safe signup error instead of arbitrary URL text", () => {
    searchParams = new URLSearchParams(
      "tab=signup&signup_error=weak_password&message=internal-provider-debug-data"
    );
    render(<LoginForm />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use a password with at least 6 characters."
    );
    expect(
      screen.queryByText("internal-provider-debug-data")
    ).not.toBeInTheDocument();
  });

  it("maps legacy signup messages to a safe fallback", () => {
    searchParams = new URLSearchParams(
      "tab=signup&message=private-provider-error"
    );
    render(<LoginForm />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't create your account right now. Try again in a moment."
    );
    expect(
      screen.queryByText("private-provider-error")
    ).not.toBeInTheDocument();
  });

  it("keeps confirmation focused and preserves the destination when resending", async () => {
    searchParams = new URLSearchParams(
      "tab=signup&signup=pending&email=client%40example.com&next=%2Fpanel%2Fw%2Fws_1%2Fscenarios"
    );
    resendSignupConfirmationMock.mockResolvedValue({ success: true });
    render(<LoginForm />);
    expect(
      screen.queryByRole("button", { name: "Continue with Google" })
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" })
    );
    await waitFor(() => {
      expect(resendSignupConfirmationMock).toHaveBeenCalledWith(
        "client@example.com",
        undefined,
        "/panel/w/ws_1/scenarios"
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Email resent. Check your inbox."
    );
  });

  it("localizes a resend failure without showing the provider message", async () => {
    searchParams = new URLSearchParams(
      "tab=signup&signup=pending&email=client%40example.com"
    );
    resendSignupConfirmationMock.mockResolvedValue({
      success: false,
      errorCode: "rate_limited",
      error: "provider-details",
    });
    render(<LoginForm />);
    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait a few minutes, then try again."
    );
    expect(screen.queryByText("provider-details")).not.toBeInTheDocument();
  });

  it("keeps unknown resend failures about the email instead of account creation", async () => {
    searchParams = new URLSearchParams(
      "tab=signup&signup=pending&email=client%40example.com"
    );
    resendSignupConfirmationMock.mockResolvedValue({
      success: false,
      errorCode: "unknown",
    });
    render(<LoginForm />);
    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not resend the email."
    );
  });

  it("shows a safe error when Google rejects an OAuth request", async () => {
    setUserAgent("Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36");
    signInWithOAuthMock.mockResolvedValue({
      error: { message: "private-oauth-details" },
    });
    render(<LoginForm />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't connect to Google. Try again or use email and password."
    );
    expect(screen.queryByText("private-oauth-details")).not.toBeInTheDocument();
  });

  it("shows a useful message instead of starting Google OAuth inside Threads", async () => {
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Barcelona/379.0.0.0.56"
    );

    render(<LoginForm />);

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" })
    );

    expect(signInWithOAuthMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("Open this page in your browser")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Google sign-in is blocked inside in-app browsers/)
    ).toBeInTheDocument();
  });

  it("preserves an invite token through Google OAuth", async () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    render(
      <LoginForm
        inviteToken="invite_1"
        inviteContext={{
          status: "valid",
          workspaceId: "workspace-1",
          workspaceName: "Acme",
          expiresAtIso: "2026-05-30T00:00:00.000Z",
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" })
    );

    await waitFor(() => {
      expect(signInWithOAuthMock).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo:
            "http://localhost/auth/callback?next=%2Fauth%2Fjoined%3Ftoken%3Dinvite_1",
        },
      });
    });
  });

  it("explains what invited users should do before accepting the workspace invite", () => {
    const inviteProps = {
      inviteToken: "invite_1",
      inviteContext: {
        status: "valid" as const,
        workspaceId: "workspace-1",
        workspaceName: "Acme",
        expiresAtIso: "2026-05-30T00:00:00.000Z",
      },
    };

    const { unmount } = render(<LoginForm {...inviteProps} />);

    expect(screen.getByText("You're invited to join Acme")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Already have an account? Sign in. New here? Choose Sign Up. Then confirm the invite to Acme."
      )
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Sign in to accept invite").length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "Use your airi.chat account email. After signing in, you will confirm the invite to Acme."
      ).length
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Sign in and continue" })
    ).toBeInTheDocument();

    unmount();
    searchParams = new URLSearchParams("tab=signup");
    render(<LoginForm {...inviteProps} />);

    expect(
      screen.getAllByText("Create account to join").length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "Create your airi.chat account. After email verification, you will confirm the invite to Acme."
      ).length
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Create account and continue" })
    ).toBeInTheDocument();
  });

  it("offers an invite-preserving sign-in link after invite password login fails", async () => {
    searchParams = new URLSearchParams(
      "message=Could+not+authenticate+user&email=client%40example.com&invite_token=invite_1"
    );

    render(
      <LoginForm
        inviteToken="invite_1"
        inviteContext={{
          status: "valid",
          workspaceId: "workspace-1",
          workspaceName: "Acme",
          expiresAtIso: "2026-05-30T00:00:00.000Z",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Send sign-in link" }));

    await waitFor(() => {
      expect(sendMagicLinkMock).toHaveBeenCalledWith(
        "client@example.com",
        "/auth/joined?token=invite_1"
      );
    });
    expect(
      screen.getByText("Sign-in link sent. Open it to accept the invite.")
    ).toBeInTheDocument();
  });

  it("keeps the Google OAuth flow unchanged in a normal Chrome browser", async () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    render(<LoginForm />);

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" })
    );

    await waitFor(() => {
      expect(signInWithOAuthMock).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo: "http://localhost/auth/callback",
        },
      });
    });
    expect(
      screen.queryByText("Open this page in your browser")
    ).not.toBeInTheDocument();
  });

  it("preserves a protected destination through Google OAuth and password sign-in", async () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    render(<LoginForm nextPath="/panel/w/workspace-1/scenarios?tab=flows" />);

    expect(
      screen.getByDisplayValue("/panel/w/workspace-1/scenarios?tab=flows")
    ).toHaveAttribute("name", "next");

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" })
    );

    await waitFor(() => {
      expect(signInWithOAuthMock).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo:
            "http://localhost/auth/callback?next=%2Fpanel%2Fw%2Fworkspace-1%2Fscenarios%3Ftab%3Dflows",
        },
      });
    });
  });
});

describe("LoginForm pending signup state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams(
      "tab=signup&signup=pending&email=fatdrfrog%40gmail.com"
    );
  });

  it("focuses on email confirmation and preserves the email when switching to sign-in", () => {
    render(<LoginForm />);

    expect(screen.getByText("Check your email")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Open the link in your email to continue."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Email sent")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with this email" })
    );

    expect(replaceMock).toHaveBeenCalledWith("/login");
    expect(screen.getByLabelText("Email")).toHaveValue("fatdrfrog@gmail.com");
  });

  it("sends obfuscated existing signup responses to sign-in instead of email-sent state", () => {
    searchParams = new URLSearchParams(
      "signup=existing&email=founder%40example.com"
    );

    render(<LoginForm />);

    expect(
      screen.getAllByText("Sign in to your account").length
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "You already have an account"
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("founder@example.com");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sign in with your existing password to continue. Your email is filled in below."
    );
    expect(screen.getByLabelText("Password")).toHaveFocus();
    expect(screen.queryByText("Email sent")).not.toBeInTheDocument();
  });
});

describe("LoginForm signup for an address that already has an account", () => {
  const inviteProps = {
    inviteToken: "invite_1",
    inviteContext: {
      status: "valid" as const,
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      expiresAtIso: "2026-05-30T00:00:00.000Z",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps the invite and destination when a returning user chooses sign-in", async () => {
    searchParams = new URLSearchParams(
      "tab=signup&invite_token=invite_1&next=%2Fpanel%2Fw%2Fworkspace-1%2Fscenarios"
    );
    const user = userEvent.setup();
    render(<LoginForm {...inviteProps} />);
    await user.type(screen.getByLabelText("Email"), "client@example.com");
    await user.click(screen.getByRole("button", { name: "Sign In", exact: true }));

    expect(screen.getByLabelText("Email")).toHaveValue("client@example.com");
    expect(replaceMock).toHaveBeenCalledWith(
      "/login?invite_token=invite_1&next=%2Fpanel%2Fw%2Fworkspace-1%2Fscenarios"
    );
    expect(signupMock).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "You already have an account"],
    ["ru", "У вас уже есть аккаунт"],
    ["kz", "Сізде аккаунт бар"],
  ])("localizes the existing-account guidance in %s", (locale, title) => {
    mockLocale = locale;
    searchParams = new URLSearchParams("signup=existing&email=client%40example.com");
    render(<LoginForm />);
    expect(screen.getByRole("status")).toHaveTextContent(title);
  });

  it("hands an existing-account response to sign-in without carrying over the signup password", async () => {
    searchParams = new URLSearchParams("tab=signup&invite_token=invite_1");
    const user = userEvent.setup();
    const { rerender } = render(<LoginForm {...inviteProps} />);
    await user.type(screen.getByLabelText("Email"), "client@example.com");
    await user.type(screen.getByLabelText("Password"), "unused-signup-password");

    searchParams = new URLSearchParams(
      "signup=existing&email=client%40example.com&invite_token=invite_1&next=%2Fpanel%2Fw%2Fworkspace-1%2Fscenarios"
    );
    rerender(<LoginForm {...inviteProps} />);

    expect(screen.getByRole("status")).toHaveTextContent("You already have an account");
    expect(screen.getByRole("tab", { name: "Sign In" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Email")).toHaveValue("client@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());
    expect(screen.getByDisplayValue("invite_1")).toHaveAttribute("name", "invite_token");
    expect(screen.getByDisplayValue("/panel/w/workspace-1/scenarios")).toHaveAttribute("name", "next");

    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "different@example.com");
    expect(screen.queryByText("You already have an account")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
  });

  it("points an already-invited email to the emailed link instead of password sign-in", () => {
    searchParams = new URLSearchParams(
      "tab=signup&signup=unconfirmed&email=client%40example.com&invite_token=invite_1"
    );

    render(<LoginForm {...inviteProps} />);

    expect(screen.getByText("Check your email")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This email already has an account that is not confirmed yet, for example from an earlier invite. We sent it a new link."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The password you entered was not saved. Open the link in the email to sign in and continue."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("client@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resend verification email" })
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Sign in with this email" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Already have an account? Sign in with this email.")
    ).not.toBeInTheDocument();
  });

  it("counts down Supabase's email cooldown instead of showing its raw error", () => {
    jest.useFakeTimers();
    searchParams = new URLSearchParams(
      "tab=signup&signup=recently_sent&email=client%40example.com&retry_after=2"
    );

    render(<LoginForm />);

    expect(
      screen.getByText(
        "We sent an email to this address less than a minute ago. Open the link in it to continue."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/For security purposes/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign in with this email" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send again in 2s" })
    ).toBeDisabled();

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(
      screen.getByRole("button", { name: "Send again in 1s" })
    ).toBeDisabled();

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(
      screen.getByRole("button", { name: "Resend verification email" })
    ).toBeEnabled();
  });

  it("turns a resend cooldown into a countdown and a plain explanation", async () => {
    resendSignupConfirmationMock.mockResolvedValue({
      success: false,
      error:
        "For security purposes, you can only request this after 42 seconds.",
      retryAfterSeconds: 42,
    });
    searchParams = new URLSearchParams(
      "tab=signup&signup=pending&email=client%40example.com"
    );

    render(<LoginForm />);

    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" })
    );

    expect(
      await screen.findByRole("button", { name: "Send again in 42s" })
    ).toBeDisabled();
    expect(resendSignupConfirmationMock).toHaveBeenCalledWith(
      "client@example.com",
      undefined,
      undefined
    );
    expect(
      screen.getByText(
        "We sent an email to this address less than a minute ago. Check your inbox and spam folder."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/For security purposes/)).not.toBeInTheDocument();
  });

  it("applies the cooldown to the invite sign-in link as well", async () => {
    sendMagicLinkMock.mockResolvedValue({
      success: false,
      error:
        "For security purposes, you can only request this after 17 seconds.",
      retryAfterSeconds: 17,
    });
    searchParams = new URLSearchParams(
      "message=Could+not+authenticate+user&email=client%40example.com&invite_token=invite_1"
    );

    render(<LoginForm {...inviteProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Send sign-in link" }));

    expect(
      await screen.findByRole("button", { name: "Send again in 17s" })
    ).toBeDisabled();
    expect(
      screen.getByText(
        "We sent an email to this address less than a minute ago. Check your inbox and spam folder."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/For security purposes/)).not.toBeInTheDocument();
  });

  it("keeps the typed email in the sign-up form after a signup error", () => {
    searchParams = new URLSearchParams(
      "tab=signup&signup_error=weak_password&email=client%40example.com"
    );

    render(<LoginForm />);

    expect(screen.getByLabelText("Email")).toHaveValue("client@example.com");
    expect(
      screen.getByText("Use a password with at least 6 characters.")
    ).toBeInTheDocument();
  });
});

describe("LoginForm password sign-in errors", () => {
  const inviteProps = {
    inviteToken: "invite_1",
    inviteContext: {
      status: "valid" as const,
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      expiresAtIso: "2026-05-30T00:00:00.000Z",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    loginMock.mockResolvedValue(undefined);
    searchParams = new URLSearchParams();
  });

  it("explains a rejected email or password in the page language with ways forward", () => {
    searchParams = new URLSearchParams("error=invalid_credentials&attempt=a1");

    render(<LoginForm />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Incorrect email or password."
    );
    expect(screen.queryByText(/invalid_credentials/)).not.toBeInTheDocument();
    expect(screen.getByText(/Signed up with Google\?/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset password" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Account" })
    ).toBeInTheDocument();
  });

  it("renders the error into the server HTML for a sign-in posted before hydration", () => {
    searchParams = new URLSearchParams("error=invalid_credentials&attempt=a1");

    const html = renderToString(<LoginForm />);

    expect(html).toContain("Incorrect email or password.");
    expect(html).toContain("Reset password");
  });

  it("clears the old error on submit and shows the next failed attempt again", async () => {
    searchParams = new URLSearchParams("error=invalid_credentials&attempt=a1");
    const { rerender } = render(<LoginForm />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "founder@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Sign In" }).closest("form")!
    );

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByText("Incorrect email or password.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reset password" })
    ).not.toBeInTheDocument();

    // The action redirects back with the same error and a new attempt marker.
    searchParams = new URLSearchParams("error=invalid_credentials&attempt=a2");
    rerender(<LoginForm />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Incorrect email or password."
    );
  });

  it("starts sign-up with the email typed into sign-in", () => {
    searchParams = new URLSearchParams("error=invalid_credentials&attempt=a1");
    render(<LoginForm />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: " founder@example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

    expect(replaceMock).toHaveBeenCalledWith("/login?tab=signup");
    expect(screen.getByLabelText("Email")).toHaveValue("founder@example.com");
  });

  it("keeps invite sign-in failures on the invite sign-in link", () => {
    searchParams = new URLSearchParams(
      "error=invalid_credentials&attempt=a1&email=client%40example.com&invite_token=invite_1"
    );

    render(<LoginForm {...inviteProps} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Incorrect email or password."
    );
    expect(
      screen.getByRole("button", { name: "Send sign-in link" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reset password" })
    ).not.toBeInTheDocument();
  });

  it("shows the rate limit without password recovery actions", () => {
    searchParams = new URLSearchParams("error=rate_limited&attempt=a1");

    render(<LoginForm />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts. Wait a minute, then try again."
    );
    expect(
      screen.queryByRole("button", { name: "Reset password" })
    ).not.toBeInTheDocument();
  });

  it("ignores an error code the login action never sends", () => {
    searchParams = new URLSearchParams("error=something_else&attempt=a1");

    render(<LoginForm />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends an unconfirmed email to the resend step instead of password sign-in", () => {
    searchParams = new URLSearchParams(
      "tab=signup&signup=email_not_confirmed&email=new%40example.com"
    );

    render(<LoginForm />);

    expect(screen.getByText("Check your email")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This account's email isn't confirmed yet. Open the link we emailed you, or send a new one."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Confirm your email")).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resend verification email" })
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Sign in with this email" })
    ).not.toBeInTheDocument();
  });
});
