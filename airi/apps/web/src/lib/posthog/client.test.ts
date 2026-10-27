import { isLocalHostname } from "./client";

describe("isLocalHostname", () => {
  it("treats local development hosts as local", () => {
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("127.0.0.1")).toBe(true);
    expect(isLocalHostname("0.0.0.0")).toBe(true);
    expect(isLocalHostname("::1")).toBe(true);
    expect(isLocalHostname("[::1]")).toBe(true);
    expect(isLocalHostname("app.localhost")).toBe(true);
    expect(isLocalHostname("my-machine.local")).toBe(true);
    expect(isLocalHostname("LOCALHOST")).toBe(true);
  });

  it("treats production hosts as non-local", () => {
    expect(isLocalHostname("nest.ai")).toBe(false);
    expect(isLocalHostname("app.nest.ai")).toBe(false);
    expect(isLocalHostname("notlocalhost.com")).toBe(false);
  });
});
