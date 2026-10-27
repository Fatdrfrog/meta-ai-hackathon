import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  getIpRateLimitIdentity,
  isDisallowedLocalHostname,
  isPrivateOrReservedIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
} from "./network-safety";

test("rate limit identities normalize IPv4 and equivalent mapped IPv4", () => {
  for (const address of [
    "198.51.100.8",
    " 198.51.100.8 ",
    "::ffff:198.51.100.8",
    "::ffff:c633:6408",
    "0:0:0:0:0:ffff:c633:6408",
    "::FFFF:C633:6408",
  ]) {
    assert.equal(getIpRateLimitIdentity(address), "198.51.100.8", address);
  }
  assert.equal(getIpRateLimitIdentity("198.51.100.9"), "198.51.100.9");
});

test("rate limit identities share one IPv6 /64 across spelling and address rotation", () => {
  for (const address of [
    "2001:db8:1234:abcd::1",
    "2001:0DB8:1234:ABCD:0000:0000:0000:0001",
    "2001:db8:1234:abcd:ffff:ffff:ffff:ffff",
  ]) {
    assert.equal(
      getIpRateLimitIdentity(address),
      "2001:db8:1234:abcd::/64",
      address,
    );
  }
  assert.equal(
    getIpRateLimitIdentity("2001:db8:1234:abce::1"),
    "2001:db8:1234:abce::/64",
  );
  assert.equal(getIpRateLimitIdentity("2001:db8::1"), "2001:db8:0:0::/64");
});

test("invalid rate limit addresses share a bounded unknown bucket", () => {
  for (const address of [
    undefined,
    null,
    "",
    "unknown",
    "random-client-id",
    "01.2.3.4",
    "198.51.100.8, 203.0.113.1",
    "198.51.100.8:443",
    "[2001:db8::1]",
    "fe80::1%eth0",
    "2001::db8::1",
    "::ffff:999.1.1.1",
    "a".repeat(1000),
  ]) {
    assert.equal(getIpRateLimitIdentity(address), "unknown", String(address));
  }
});

test("keeps network safety compatible with browser bundles", () => {
  const source = readFileSync(
    resolve(__dirname, "../../src/lib/network-safety.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /(?:from|require\()\s*["']node:/);
});

test("rejects private, loopback, link-local, documentation, and reserved IPv4", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isPrivateOrReservedIpv4(address), true, address);
  }
  assert.equal(isPrivateOrReservedIpv4("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedIpv4("192.0.0.9"), false);
  assert.equal(isPrivateOrReservedIpv4("192.0.0.10"), false);
  assert.equal(isPrivateOrReservedIpv4("192.0.1.1"), false);
  assert.equal(isPrivateOrReservedIpv4("198.51.99.1"), false);
  assert.equal(isPrivateOrReservedIpv4("203.0.114.1"), false);
  for (const address of ["999.1.1.1", "1.2.3.", "01.2.3.4", "1e0.2.3.4"]) {
    assert.equal(isPrivateOrReservedIpv4(address), true, address);
  }
});

test("rejects private and reserved IPv6 including mapped IPv4", () => {
  for (const address of [
    "::",
    "::1",
    "0:0:0:0:0:0:0:0",
    "0:0:0:0:0:0:0:1",
    "100:0:0:1::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "fec0::1",
    "ff00::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:0:7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
  ]) {
    assert.equal(isPrivateOrReservedIpv6(address), true, address);
  }
  assert.equal(isPrivateOrReservedIpv6("64:ff9b::808:808"), false);
  assert.equal(isPrivateOrReservedIpv6("::ffff:808:808"), false);
  assert.equal(isPrivateOrReservedIpv6("::ffff:0:808:808"), false);
  for (const address of [
    "2001:1::1",
    "2001:1::2",
    "2001:1::3",
    "2001:3::1",
    "2001:4:112::1",
    "2001:20::1",
    "2001:30::1",
  ]) {
    assert.equal(isPrivateOrReservedIpv6(address), false, address);
  }
  for (const address of [
    "2001::db8::1",
    "2001:db8:0:0:0:0:0",
    "2001:db8:0:0:0:0:0:0:1",
    "2001:db8::gggg",
    "2001:db8::1z",
    "1:2:3:4:5:6:7:8::",
    "::ffff:999.1.1.1",
  ]) {
    assert.equal(isPrivateOrReservedIpv6(address), true, address);
  }
  assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);
});

test("rejects local hostname forms without rejecting ordinary public hosts", () => {
  for (const host of [
    "localhost",
    "api.localhost",
    "printer.local",
    "svc.internal",
  ]) {
    assert.equal(isDisallowedLocalHostname(host), true, host);
  }
  assert.equal(isDisallowedLocalHostname("cdn.example.com"), false);
});
