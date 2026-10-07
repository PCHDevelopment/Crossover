import { createSandboxProxyCredential } from "@crossover/security";

export function proxyAuthorization(sandboxId: string, secret: string): string {
  const credential = createSandboxProxyCredential(sandboxId, secret);
  return `Basic ${Buffer.from(`${sandboxId}:${credential}`).toString("base64")}`;
}
