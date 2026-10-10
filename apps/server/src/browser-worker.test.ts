import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBrowserInvocation } from "../../../plugins/browser/worker.mjs";

const originalProxy = process.env.HTTPS_PROXY;

afterEach(() => {
  if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = originalProxy;
});

describe("browser worker", () => {
  it("starts a fresh proxied browser and returns only absolute HTTPS links on port 443", async () => {
    process.env.HTTPS_PROXY = "http://plugin:fixture-token@egress-proxy:3128";
    const fixture = makeBrowser({
      finalUrl: "https://example.com/final",
      links: [
        { text: "x".repeat(250), href: "https://example.com/allowed" },
        { text: "Plain HTTP", href: "http://example.com/" },
        { text: "Wrong port", href: "https://example.com:444/" },
        { text: "Long URL", href: `https://example.com/${"x".repeat(2_048)}` },
        ...Array.from({ length: 205 }, (_, index) => ({
          text: `link ${index}`,
          href: `https://example.com/link-${index}`,
        })),
      ],
    });

    const result = (await handleBrowserInvocation(
      { tool: "browser.navigate", args: { url: "https://example.com" } },
      { chromium: fixture.chromium },
    )) as { final_url: string; status: number; title: string; links: unknown[] };

    expect(result).toEqual({
      final_url: "https://example.com/final",
      status: 200,
      title: "fixture page",
      links: [
        { text: "x".repeat(200), href: "https://example.com/allowed" },
        ...Array.from({ length: 199 }, (_, index) => ({
          text: `link ${index}`,
          href: `https://example.com/link-${index}`,
        })),
      ],
    });
    expect(result.links).toHaveLength(200);
    expect(
      (result.links as { text: string; href: string }[]).every(
        (link) => link.text.length <= 200 && link.href.length <= 2_048,
      ),
    ).toBe(true);
    expect(fixture.launch).toHaveBeenCalledTimes(1);
    const launch = fixture.launch.mock.calls[0]![0] as unknown as {
      proxy: { server: string; username: string; password: string; bypass: string };
      args: string[];
    };
    expect(launch.proxy).toEqual({
      server: "http://egress-proxy:3128",
      username: "plugin",
      password: "fixture-token",
      bypass: "<-loopback>",
    });
    expect(launch.args).toContain("--proxy-bypass-list=<-loopback>");
    expect(launch.args).toContain("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE egress-proxy");
    expect(fixture.browser.newContext).toHaveBeenCalledWith({
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(fixture.context.close).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTP before starting Chromium and truncates text at a UTF-8 byte boundary", async () => {
    const invalidFixture = makeBrowser({});
    await expect(
      handleBrowserInvocation(
        { tool: "browser.navigate", args: { url: "http://example.com" } },
        { chromium: invalidFixture.chromium },
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(invalidFixture.launch).not.toHaveBeenCalled();

    process.env.HTTPS_PROXY = "http://plugin:fixture-token@egress-proxy:3128";
    const textFixture = makeBrowser({ text: "é".repeat(32_769) });
    const result = (await handleBrowserInvocation(
      { tool: "browser.read_page", args: { url: "https://example.com" } },
      { chromium: textFixture.chromium },
    )) as { text: string; truncated: boolean };

    expect(Buffer.byteLength(result.text, "utf8")).toBe(64 * 1024);
    expect(result.text).toBe("é".repeat(32_768));
    expect(result.truncated).toBe(true);
  });
});

function makeBrowser(input: {
  finalUrl?: string;
  text?: string;
  links?: { text: string; href: string }[];
}) {
  const anchors = (input.links ?? []).map((link) => ({
    href: link.href,
    innerText: link.text,
  }));
  const page = {
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(async () => ({ status: () => 200 })),
    url: () => input.finalUrl ?? "https://example.com/",
    title: async () => "fixture page",
    locator: (selector: string) =>
      selector === "a[href]"
        ? {
            evaluateAll: async (
              mapAnchors: (nodes: object[], maxLinkText: number) => unknown,
              maxLinkText: number,
            ) => mapAnchors(anchors, maxLinkText),
          }
        : {
            innerText: async () => input.text ?? "fixture body",
            count: async () => 1,
            first() {
              return this;
            },
          },
  };
  const context = {
    addInitScript: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  const launch = vi.fn(async (_options: unknown) => browser);
  return { chromium: { launch }, launch, context, browser };
}
