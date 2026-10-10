export class BrowserPluginError extends Error {
  code: string;
  retryable: boolean;
}

export function handleBrowserInvocation(invocation: unknown, options?: unknown): Promise<unknown>;
