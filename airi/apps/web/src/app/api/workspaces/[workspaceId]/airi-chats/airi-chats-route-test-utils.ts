// Request builders shared by the airi-chats route suites. jest.mock factories
// stay in each suite.

import type { NextRequest } from "next/server";

export function request(url = "http://localhost/api", init?: RequestInit) {
  return new Request(url, init) as unknown as NextRequest;
}

/**
 * Call `handler` with a JSON body posted to http://localhost/api. `init`
 * overrides the method (PATCH) or adds an AbortSignal.
 */
export function postJson<Context>(
  handler: (request: NextRequest, context: Context) => Promise<Response>,
  body: unknown,
  context: Context,
  init?: RequestInit
) {
  return handler(
    request("http://localhost/api", {
      method: "POST",
      body: JSON.stringify(body),
      ...init,
    }),
    context
  );
}
