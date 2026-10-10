import type { ToolDefinition, ToolRegistry } from "@crossover/kernel";
import { z } from "zod";

const HTTPS_URL = z.string().min(1).max(2_048).refine(isAllowedBrowserUrl, {
  message: "URL must be HTTPS on port 443 without credentials",
});

export const browserNavigateParams = z.strictObject({ url: HTTPS_URL });
export const browserReadPageParams = z.strictObject({
  url: HTTPS_URL,
  selector: z.string().min(1).max(2_048).optional(),
});

const execution = (image: string) => ({
  image,
  command: ["node", "/app/plugins/browser/worker.mjs"],
  egressHosts: [],
  roomEgressAllowlist: true,
  pidsLimit: 256,
  maxOutputBytes: 256 * 1024,
});

export function registerBrowserTools(registry: ToolRegistry, image: string): void {
  const definitions: ToolDefinition[] = [
    {
      name: "browser.navigate",
      description: "Read page metadata and up to 200 HTTPS links from a web page.",
      capability: "browser.navigate",
      tier: 2,
      input: browserNavigateParams,
      idempotent: true,
      execution: execution(image),
    },
    {
      name: "browser.read_page",
      description: "Read up to 64 KiB of visible text from a web page or CSS selector.",
      capability: "browser.navigate",
      tier: 2,
      input: browserReadPageParams,
      idempotent: true,
      execution: execution(image),
    },
  ];
  for (const definition of definitions)
    if (!registry.get(definition.name)) registry.register(definition);
}

function isAllowedBrowserUrl(value: string): boolean {
  if (value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
