import { describe, expect, it } from "vitest";
import { isPrivateAddress, resolvePublicAddresses } from "./network.js";

describe("isPrivateAddress", () => {
  it("rejects private, loopback, link-local, CGNAT, and mapped IPv4 addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("accepts globally routable IPv4 and IPv6 addresses", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("resolvePublicAddresses", () => {
  it("returns the public answers so callers can pin the connection to the checked DNS result", async () => {
    const resolve = async (host: string) => {
      expect(host).toBe("registry.example");
      return ["93.184.216.34", "2606:4700:4700::1111"];
    };
    await expect(resolvePublicAddresses("registry.example", resolve)).resolves.toEqual([
      "93.184.216.34",
      "2606:4700:4700::1111",
    ]);
  });

  it("rejects a mixed public/private DNS answer and unresolved names", async () => {
    await expect(
      resolvePublicAddresses("registry.example", async () => ["93.184.216.34", "10.0.0.1"]),
    ).rejects.toThrow(/public addresses/);
    await expect(resolvePublicAddresses("missing.example", async () => [])).rejects.toThrow(
      /public addresses/,
    );
    await expect(
      resolvePublicAddresses("registry.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/public addresses/);
  });
});
