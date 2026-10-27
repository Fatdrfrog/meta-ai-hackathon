/** @jest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { AuthProvider, useAuth } from "./auth-context";
import type { Session } from "@supabase/supabase-js";

const mockSetPostHogUser = jest.fn().mockResolvedValue(undefined);
const mockGetSession = jest.fn();
const mockUnsubscribe = jest.fn();
let mockAuthChange: (event: string, session: Session | null) => void;
const mockSupabase = {
  auth: {
    getSession: mockGetSession,
    onAuthStateChange: (callback: typeof mockAuthChange) => {
      mockAuthChange = callback;
      return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
    },
    signOut: jest.fn(),
  },
};
jest.mock("@/lib/supabase/client", () => ({
  createClient: () => mockSupabase,
}));
jest.mock("@/lib/posthog/client", () => ({
  setPostHogUser: (...args: unknown[]) => mockSetPostHogUser(...args),
}));

const session = { user: { id: "user-a", email: "a@example.com" } } as Session;
function Consumer() {
  const { user, loading } = useAuth();
  return <span>{loading ? "loading" : (user?.id ?? "signed-out")}</span>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session } });
});
afterEach(cleanup);

it("synchronizes an already authenticated session without waiting for SIGNED_IN", async () => {
  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
  await screen.findByText("user-a");
  expect(mockSetPostHogUser).toHaveBeenCalledWith(session.user, {
    reset: false,
  });
});

it("does not restore a stale initial session after SIGNED_OUT", async () => {
  let resolve!: (value: unknown) => void;
  mockGetSession.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
  act(() => mockAuthChange("SIGNED_OUT", null));
  await act(async () => resolve({ data: { session } }));
  expect(screen.getByText("signed-out")).toBeTruthy();
  expect(mockSetPostHogUser).toHaveBeenCalledTimes(1);
  expect(mockSetPostHogUser).toHaveBeenCalledWith(null, { reset: true });
});

it("does not identify a session after its provider unmounted", async () => {
  let resolve!: (value: unknown) => void;
  mockGetSession.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  const view = render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
  view.unmount();
  await act(async () => resolve({ data: { session } }));
  expect(mockSetPostHogUser).not.toHaveBeenCalled();
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});
