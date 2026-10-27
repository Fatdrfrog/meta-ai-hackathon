import {
  createFacebookLoginCallback,
  type FacebookLoginResponse,
} from "./facebook-sdk";

describe("createFacebookLoginCallback", () => {
  it("wraps async handlers in a plain function for the Facebook JS SDK", async () => {
    const handler = jest.fn<Promise<void>, [FacebookLoginResponse]>(() =>
      Promise.resolve()
    );
    const callback = createFacebookLoginCallback(handler);

    expect(callback.constructor.name).toBe("Function");
    expect(callback({ status: "connected" })).toBeUndefined();

    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith({ status: "connected" });
  });

  it("routes async handler failures to the provided error callback", async () => {
    const error = new Error("failed");
    const onError = jest.fn();
    const callback = createFacebookLoginCallback(
      () => Promise.reject(error),
      onError
    );

    callback({ status: "unknown" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
