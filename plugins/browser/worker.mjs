// @ts-check
import { Buffer } from "node:buffer";
import process, { stdin, stdout } from "node:process";
import { pathToFileURL, URL } from "node:url";
import { TextDecoder } from "node:util";
import { chromium } from "playwright-core";

/* global window */

/** @typedef {{ text: string, href: string }} BrowserLink */
/** @typedef {{ final_url: string, status: number, title: string }} BrowserPageSummary */
/** @typedef {BrowserPageSummary & { links: BrowserLink[] }} NavigateResult */
/** @typedef {BrowserPageSummary & { text: string, truncated: boolean }} ReadPageResult */
/** @typedef {NavigateResult | ReadPageResult} BrowserResult */
/** @typedef {{ chromium?: typeof chromium, ignoreHTTPSErrors?: boolean }} BrowserInvocationOptions */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_PAGE_TEXT_BYTES = 64 * 1024;
const MAX_LINKS = 200;
const MAX_LINK_TEXT = 200;
const MAX_LINK_HREF = 2_048;
const NAVIGATION_TIMEOUT_MS = 20_000;

export class BrowserPluginError extends Error {
  /** @param {string} code @param {string} message @param {boolean} [retryable] */
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * @param {unknown} invocation
 * @param {BrowserInvocationOptions} [options]
 * @returns {Promise<BrowserResult>}
 */
export async function handleBrowserInvocation(invocation, options = {}) {
  const request = isRecord(invocation) ? invocation : undefined;
  if (!request) throw new BrowserPluginError("validation", "Browser tool is invalid");
  const tool = request.tool;
  if (tool !== "browser.navigate" && tool !== "browser.read_page")
    throw new BrowserPluginError("validation", "Browser tool is invalid");
  const args = request.args;
  if (!isRecord(args)) throw new BrowserPluginError("validation", "Browser arguments are invalid");
  const url = validateUrl(args.url);
  if (tool === "browser.navigate" && Object.keys(args).some((key) => key !== "url"))
    throw new BrowserPluginError("validation", "Browser navigation arguments are invalid");
  if (
    tool === "browser.read_page" &&
    (Object.keys(args).some((key) => key !== "url" && key !== "selector") ||
      (args.selector !== undefined &&
        (typeof args.selector !== "string" ||
          args.selector.length === 0 ||
          args.selector.length > 2_048)))
  ) {
    throw new BrowserPluginError("validation", "Browser page arguments are invalid");
  }

  const proxy = parseProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy);
  const browserType = options.chromium ?? chromium;
  /** @type {import("playwright-core").Browser | undefined} */
  let browser;
  /** @type {import("playwright-core").BrowserContext | undefined} */
  let context;
  try {
    browser = await browserType.launch({
      headless: true,
      timeout: NAVIGATION_TIMEOUT_MS,
      proxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
        bypass: "<-loopback>",
      },
      args: [
        "--no-sandbox",
        "--proxy-bypass-list=<-loopback>",
        `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxy.host}`,
      ],
    });
    context = await browser.newContext({
      acceptDownloads: false,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors === true,
    });
    await context.addInitScript(() => {
      Object.defineProperty(window, "open", {
        configurable: false,
        value: () => null,
        writable: false,
      });
    });
    await context.route("**/*", async (route) => {
      let requestUrl;
      try {
        requestUrl = new URL(route.request().url());
      } catch {
        await route.abort();
        return;
      }
      if (
        requestUrl.protocol !== "https:" ||
        (requestUrl.port !== "" && requestUrl.port !== "443") ||
        requestUrl.username !== "" ||
        requestUrl.password !== ""
      ) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    context.on("page", (popup) => {
      if (popup !== page) void popup.close().catch(() => undefined);
    });
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    const response = await page.goto(url.href, {
      timeout: NAVIGATION_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    const finalUrl = boundedPageUrl(page.url());
    const status = response?.status() ?? 0;
    const title = (await page.title()).slice(0, 1_024);

    if (tool === "browser.navigate") {
      const links = await collectLinks(page);
      const result = { final_url: finalUrl, status, title, links };
      while (
        links.length > 0 &&
        Buffer.byteLength(JSON.stringify({ result })) > MAX_TOOL_OUTPUT_BYTES
      ) {
        links.pop();
      }
      assertOutputBound(result);
      return result;
    }

    const selector = typeof args.selector === "string" ? args.selector : undefined;
    let text = "";
    if (selector === undefined) {
      text = await page.locator("body").innerText();
    } else {
      let target;
      try {
        target = page.locator(selector);
        if ((await target.count()) > 0) text = await target.first().innerText();
      } catch {
        throw new BrowserPluginError("validation", "Browser selector is invalid");
      }
    }
    const limited = truncateUtf8(text, MAX_PAGE_TEXT_BYTES);
    const result = {
      final_url: finalUrl,
      status,
      title,
      text: limited.text,
      truncated: limited.truncated,
    };
    assertOutputBound(result);
    return result;
  } catch (error) {
    if (error instanceof BrowserPluginError) throw error;
    throw new BrowserPluginError("unavailable", "Browser navigation failed", true);
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

/** @param {unknown} value @returns {URL} */
function validateUrl(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LINK_HREF ||
    value !== value.trim()
  )
    throw new BrowserPluginError("validation", "Browser URL is invalid");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserPluginError("validation", "Browser URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new BrowserPluginError("validation", "Browser URL must be HTTPS on port 443");
  }
  return url;
}

/** @param {string | undefined} value */
function parseProxy(value) {
  let url;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new BrowserPluginError("unavailable", "Browser proxy is unavailable", true);
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "plugin" ||
    url.password.length === 0 ||
    url.hostname.length === 0 ||
    url.port.length === 0 ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BrowserPluginError("unavailable", "Browser proxy is unavailable", true);
  }
  return {
    server: `http://${url.hostname}:${url.port}`,
    username: url.username,
    password: url.password,
    host: url.hostname,
  };
}

/** @param {import("playwright-core").Page} page @returns {Promise<BrowserLink[]>} */
async function collectLinks(page) {
  const candidates = await page.locator("a[href]").evaluateAll(
    (anchors, maxLinkText) =>
      anchors.slice(0, 1_000).map((anchor) => {
        const link = /** @type {HTMLAnchorElement} */ (anchor);
        return {
          href: link.href,
          text: (link.innerText ?? "").trim().slice(0, maxLinkText),
        };
      }),
    MAX_LINK_TEXT,
  );
  const links = [];
  for (const candidate of candidates) {
    let href;
    try {
      href = new URL(candidate.href);
    } catch {
      continue;
    }
    if (
      href.protocol !== "https:" ||
      (href.port !== "" && href.port !== "443") ||
      href.username !== "" ||
      href.password !== "" ||
      href.href.length > MAX_LINK_HREF
    ) {
      continue;
    }
    links.push({ text: candidate.text.slice(0, MAX_LINK_TEXT), href: href.href });
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

/** @param {string} value @returns {string} */
function boundedPageUrl(value) {
  if (value.length > MAX_LINK_HREF)
    throw new BrowserPluginError("unavailable", "Browser page URL exceeds the size limit");
  return value;
}

/** @param {string} value @param {number} maxBytes */
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

/** @param {BrowserResult} result */
function assertOutputBound(result) {
  if (Buffer.byteLength(JSON.stringify({ result })) > MAX_TOOL_OUTPUT_BYTES)
    throw new BrowserPluginError("unavailable", "Browser result exceeds the size limit");
}

/** @returns {Promise<unknown>} */
async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES)
      throw new BrowserPluginError("validation", "Browser request exceeds the size limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BrowserPluginError("validation", "Browser request is invalid");
  }
}

async function main() {
  try {
    const request = await readRequest();
    const invocation = isRecord(request) ? request.invocation : undefined;
    const result = await handleBrowserInvocation(invocation);
    stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    const known = error instanceof BrowserPluginError ? error : undefined;
    stdout.write(
      `${JSON.stringify({
        error: {
          code: known?.code ?? "unavailable",
          message: known?.message ?? "Browser plugin failed",
          retryable: known?.retryable ?? true,
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
