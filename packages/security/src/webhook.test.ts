import { describe, expect, it } from "vitest";
import { postWebhook } from "./webhook.js";

const request = (url: string) => ({ url, body: "{}", headers: {} });

describe("postWebhook", () => {
  it("refuses what isn't a plain public https URL, before connecting to anything", async () => {
    for (const url of [
      "http://hooks.example/x",
      "https://user:pw@hooks.example/x",
      "https://hooks.example:8443/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      await expect(
        postWebhook(request(url), { resolve: async () => ["93.184.216.34"] }),
        url,
      ).rejects.toThrow();
    }
  });

  it("refuses a name that resolves to a private address, or to a mix with one", async () => {
    await expect(
      postWebhook(request("https://hooks.example/x"), { resolve: async () => ["10.0.0.5"] }),
    ).rejects.toThrow(/public/);
    await expect(
      postWebhook(request("https://hooks.example/x"), {
        resolve: async () => ["93.184.216.34", "127.0.0.1"],
      }),
    ).rejects.toThrow(/public/);
    await expect(
      postWebhook(request("https://nope.example/x"), { resolve: async () => [] }),
    ).rejects.toThrow();
  });
});
