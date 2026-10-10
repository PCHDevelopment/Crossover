import { stdin, stdout } from "node:process";
import process from "node:process";
import { Buffer } from "node:buffer";
import { BrowserPluginError, handleBrowserInvocation } from "../worker.mjs";

async function main() {
  let invocation;
  try {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    invocation = request.invocation;
  } catch {
    stdout.write(
      `${JSON.stringify({
        error: { code: "validation", message: "Browser request is invalid", retryable: false },
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    // This test target uses a local CA. The production worker always verifies public TLS.
    const result = await handleBrowserInvocation(invocation, { ignoreHTTPSErrors: true });
    stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    const known = error instanceof BrowserPluginError;
    stdout.write(
      `${JSON.stringify({
        error: {
          code: known ? error.code : "unavailable",
          message: known ? error.message : "Browser plugin failed",
          retryable: known ? error.retryable : true,
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
