import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blockedIpv4 = new BlockList();
for (const [subnet, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(subnet, prefix, "ipv4");
}

const blockedIpv6 = new BlockList();
for (const [subnet, prefix] of [
  ["::", 96], // unspecified, loopback, and deprecated IPv4-compatible forms
  ["::ffff:0:0", 96], // IPv4-mapped
  ["::ffff:0:0:0", 96], // IPv4-translated
  ["64:ff9b::", 96], // well-known NAT64 prefix
  ["2001::", 32], // Teredo embeds an IPv4 address
  ["2002::", 16], // 6to4 embeds an IPv4 address
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  blockedIpv6.addSubnet(subnet, prefix, "ipv6");
}

/** Addresses a server must not connect to on a user's say-so (SSRF protection). */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedIpv4.check(address, "ipv4");
  if (version === 6) return blockedIpv6.check(address, "ipv6");
  return true; // not an address at all: refuse
}

export type HostResolver = (host: string) => Promise<string[]>;

const resolveHost: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** Resolve a hostname once and return only addresses safe to connect to directly. */
export async function resolvePublicAddresses(
  host: string,
  resolve: HostResolver = resolveHost,
): Promise<string[]> {
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("host does not resolve exclusively to public addresses");
  }
  return [...new Set(addresses)];
}
