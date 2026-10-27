function normalizeHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  if (parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return null;
  }
  return (
    (((octets[0]! << 24) >>> 0) |
      (octets[1]! << 16) |
      (octets[2]! << 8) |
      octets[3]!) >>>
    0
  );
}

function isIpv4InCidr(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

const RESERVED_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

const GLOBALLY_REACHABLE_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> =
  [
    [0xc0000009, 32],
    [0xc000000a, 32],
  ];

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const value = parseIpv4(ip);
  if (value === null) return true;
  if (
    GLOBALLY_REACHABLE_IPV4_CIDRS.some(([network, prefix]) =>
      isIpv4InCidr(value, network, prefix),
    )
  ) {
    return false;
  }
  return RESERVED_IPV4_CIDRS.some(([network, prefix]) =>
    isIpv4InCidr(value, network, prefix),
  );
}

function parseIpv6(ip: string): number[] | null {
  let host = normalizeHost(ip).replace(/%.*$/, "");

  if (host.includes(".")) {
    const lastColon = host.lastIndexOf(":");
    const embedded = parseIpv4(host.slice(lastColon + 1));
    if (embedded === null) return null;
    host = `${host.slice(0, lastColon)}:${(embedded >>> 16).toString(16)}:${(
      embedded & 0xffff
    ).toString(16)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (
    (halves.length === 2 && omitted < 1) ||
    (halves.length === 1 && left.length !== 8)
  ) {
    return null;
  }
  const groups = [...left, ...Array<string>(omitted).fill("0"), ...right];
  if (groups.length !== 8) return null;

  const value: number[] = [];
  for (const group of groups) {
    if (!/^[\da-f]{1,4}$/i.test(group)) return null;
    const parsed = Number.parseInt(group, 16);
    value.push(parsed);
  }
  return value;
}

function ipv6Network(address: string): number[] {
  const value = parseIpv6(address);
  if (value === null) throw new Error(`Invalid internal IPv6 CIDR: ${address}`);
  return value;
}

function isIpv6InCidr(
  value: readonly number[],
  network: readonly number[],
  prefix: number,
): boolean {
  const wholeGroups = Math.floor(prefix / 16);
  for (let index = 0; index < wholeGroups; index += 1) {
    if (value[index] !== network[index]) return false;
  }
  const remainingBits = prefix % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (value[wholeGroups]! & mask) === (network[wholeGroups]! & mask);
}

const IPV4_COMPATIBLE_NETWORK = ipv6Network("::");
const IPV4_MAPPED_NETWORK = ipv6Network("::ffff:0:0");
const IPV4_TRANSLATABLE_NETWORK = ipv6Network("::ffff:0:0:0");
const NAT64_WELL_KNOWN_NETWORK = ipv6Network("64:ff9b::");

const GLOBALLY_REACHABLE_IPV6_CIDRS: ReadonlyArray<
  readonly [number[], number]
> = [
  [ipv6Network("2001:1::1"), 128],
  [ipv6Network("2001:1::2"), 128],
  [ipv6Network("2001:1::3"), 128],
  [ipv6Network("2001:3::"), 32],
  [ipv6Network("2001:4:112::"), 48],
  [ipv6Network("2001:20::"), 28],
  [ipv6Network("2001:30::"), 28],
];

const RESERVED_IPV6_CIDRS: ReadonlyArray<readonly [number[], number]> = [
  [ipv6Network("100::"), 64],
  [ipv6Network("100:0:0:1::"), 64],
  [ipv6Network("2001::"), 23],
  [ipv6Network("2001:db8::"), 32],
  [ipv6Network("2002::"), 16],
  [ipv6Network("3fff::"), 20],
  [ipv6Network("5f00::"), 16],
  [ipv6Network("64:ff9b:1::"), 48],
  [ipv6Network("fc00::"), 7],
  [ipv6Network("fe80::"), 10],
  [ipv6Network("fec0::"), 10],
  [ipv6Network("ff00::"), 8],
];

function embeddedIpv4(value: readonly number[]): string {
  const high = value[6]!;
  const low = value[7]!;
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

/**
 * Stable rate-limit identity after a caller has established proxy-header trust.
 * IPv6 privacy-address rotation shares a /64; malformed values share one bucket.
 */
export function getIpRateLimitIdentity(
  value: string | null | undefined,
): string {
  const host = value?.trim().toLowerCase();
  if (!host || host.length > 64 || !/^[\da-f:.]+$/.test(host)) return "unknown";
  if (parseIpv4(host) !== null) return host;
  const address = parseIpv6(host);
  if (!address) return "unknown";
  if (isIpv6InCidr(address, IPV4_MAPPED_NETWORK, 96))
    return embeddedIpv4(address);
  return `${address
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

export function isPrivateOrReservedIpv6(ip: string): boolean {
  const value = parseIpv6(ip);
  if (value === null) return true;
  if (
    GLOBALLY_REACHABLE_IPV6_CIDRS.some(([network, prefix]) =>
      isIpv6InCidr(value, network, prefix),
    )
  ) {
    return false;
  }
  if (
    isIpv6InCidr(value, IPV4_COMPATIBLE_NETWORK, 96) ||
    isIpv6InCidr(value, IPV4_MAPPED_NETWORK, 96) ||
    isIpv6InCidr(value, IPV4_TRANSLATABLE_NETWORK, 96) ||
    isIpv6InCidr(value, NAT64_WELL_KNOWN_NETWORK, 96)
  ) {
    return isPrivateOrReservedIpv4(embeddedIpv4(value));
  }
  return RESERVED_IPV6_CIDRS.some(([network, prefix]) =>
    isIpv6InCidr(value, network, prefix),
  );
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const host = normalizeHost(ip).replace(/%.*$/, "");
  if (parseIpv4(host) !== null) return isPrivateOrReservedIpv4(host);
  if (parseIpv6(host) !== null) return isPrivateOrReservedIpv6(host);
  return false;
}

export function isDisallowedLocalHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  return isPrivateOrReservedIp(host);
}
