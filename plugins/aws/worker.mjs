// @ts-check
import { Buffer } from "node:buffer";
import process, { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LOG_MESSAGE_JSON_BYTES = 8 * 1024;
const MAX_LOG_STREAM_JSON_BYTES = 1_024;
const MAX_LOG_EVENTS_PER_PAGE = 20;
const MAX_NEXT_TOKEN_BYTES = 2_048;
const MAX_LOG_RANGE_MS = 24 * 60 * 60 * 1_000;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d+$/;
const LOG_GROUP_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):logs:([a-z0-9-]+):(\d{12}):log-group:([A-Za-z0-9._/#-]+)(?::\*)?$/;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/** @typedef {{ tool: string, scope?: string, args: Record<string, unknown> }} AwsInvocation */
/** @typedef {{ send(command: import("@aws-sdk/client-cloudwatch-logs").FilterLogEventsCommand): Promise<import("@aws-sdk/client-cloudwatch-logs").FilterLogEventsCommandOutput> }} LogsClientLike */
/** @typedef {{ send(command: import("@aws-sdk/client-lambda").UpdateFunctionCodeCommand): Promise<import("@aws-sdk/client-lambda").UpdateFunctionCodeCommandOutput> }} LambdaClientLike */
/** @typedef {{ logsClient?: LogsClientLike, lambdaClient?: LambdaClientLike, env?: NodeJS.ProcessEnv }} InvocationOptions */

export class AwsPluginError extends Error {
  /** @param {"validation" | "forbidden" | "not_found" | "rate_limited" | "unavailable"} code @param {boolean} retryable */
  constructor(code, retryable = false) {
    super("AWS plugin request failed");
    this.code = code;
    this.retryable = retryable;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {AwsInvocation} */
function parseInvocation(value) {
  if (!isRecord(value) || typeof value.tool !== "string" || !isRecord(value.args))
    throw new AwsPluginError("validation");
  return /** @type {AwsInvocation} */ (value);
}

/** @param {AwsInvocation} invocation @param {InvocationOptions} [options] */
export async function handleAwsInvocation(invocation, options = {}) {
  const request = parseInvocation(invocation);
  if (request.tool === "aws.read_logs") return readLogs(request, options);
  if (request.tool === "aws.deploy_lambda") return deployLambda(request, options);
  throw new AwsPluginError("validation");
}

/** @param {AwsInvocation} request @param {InvocationOptions} options */
async function readLogs(request, options) {
  const args = request.args;
  const allowed = new Set([
    "log_group_arn",
    "start_time",
    "end_time",
    "filter_pattern",
    "log_stream_names",
    "limit",
    "next_token",
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new AwsPluginError("validation");
  if (typeof args.log_group_arn !== "string" || typeof request.scope !== "string")
    throw new AwsPluginError("validation");
  const arn = canonicalLogGroupArn(args.log_group_arn);
  if (arn !== request.scope) throw new AwsPluginError("forbidden");
  const parsedArn = LOG_GROUP_ARN.exec(arn);
  if (!parsedArn) throw new AwsPluginError("validation");
  const region = parsedArn[2];
  if (typeof region !== "string" || !REGION.test(region)) throw new AwsPluginError("validation");

  if (
    typeof args.start_time !== "string" ||
    typeof args.end_time !== "string" ||
    !Number.isFinite(Date.parse(args.start_time)) ||
    !Number.isFinite(Date.parse(args.end_time))
  ) {
    throw new AwsPluginError("validation");
  }
  const startTime = Date.parse(args.start_time);
  const endTime = Date.parse(args.end_time);
  if (endTime <= startTime || endTime > Date.now() || endTime - startTime > MAX_LOG_RANGE_MS)
    throw new AwsPluginError("validation");
  if (
    args.filter_pattern !== undefined &&
    (typeof args.filter_pattern !== "string" || args.filter_pattern.length > 1_024)
  )
    throw new AwsPluginError("validation");
  if (
    args.log_stream_names !== undefined &&
    (!Array.isArray(args.log_stream_names) ||
      args.log_stream_names.length < 1 ||
      args.log_stream_names.length > 10 ||
      args.log_stream_names.some(
        (name) => typeof name !== "string" || name.length < 1 || name.length > 512,
      ))
  ) {
    throw new AwsPluginError("validation");
  }
  const requestedLimit = args.limit === undefined ? 100 : args.limit;
  if (
    typeof requestedLimit !== "number" ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 1_000
  )
    throw new AwsPluginError("validation");
  if (
    args.next_token !== undefined &&
    (typeof args.next_token !== "string" ||
      Buffer.byteLength(args.next_token) > MAX_NEXT_TOKEN_BYTES)
  )
    throw new AwsPluginError("validation");

  const client = options.logsClient ?? createLogsClient(region, options.env ?? process.env);
  const owned = options.logsClient === undefined;
  try {
    const response = await client.send(
      new FilterLogEventsCommand({
        // CloudWatch's logGroupIdentifier ARN format ends with the resource wildcard.
        logGroupIdentifier: `${arn}:*`,
        startTime,
        endTime,
        ...(typeof args.filter_pattern === "string" ? { filterPattern: args.filter_pattern } : {}),
        ...(Array.isArray(args.log_stream_names) ? { logStreamNames: args.log_stream_names } : {}),
        limit: Math.min(requestedLimit, MAX_LOG_EVENTS_PER_PAGE),
        ...(typeof args.next_token === "string" ? { nextToken: args.next_token } : {}),
      }),
    );
    const rawEvents = Array.isArray(response.events) ? response.events : [];
    /** @type {{timestamp: number, log_stream: string, message: string}[]} */
    const events = [];
    let truncated =
      typeof response.nextToken === "string" || rawEvents.length > MAX_LOG_EVENTS_PER_PAGE;
    for (const item of rawEvents.slice(0, MAX_LOG_EVENTS_PER_PAGE)) {
      if (
        typeof item.timestamp !== "number" ||
        !Number.isSafeInteger(item.timestamp) ||
        typeof item.logStreamName !== "string" ||
        typeof item.message !== "string"
      ) {
        truncated = true;
        continue;
      }
      const message = capJsonString(item.message, MAX_LOG_MESSAGE_JSON_BYTES);
      const logStream = capJsonString(item.logStreamName, MAX_LOG_STREAM_JSON_BYTES);
      if (message !== item.message || logStream !== item.logStreamName) truncated = true;
      events.push({ timestamp: item.timestamp, log_stream: logStream, message });
    }
    if (typeof response.nextToken === "string") {
      if (Buffer.byteLength(response.nextToken) > MAX_NEXT_TOKEN_BYTES)
        throw new AwsPluginError("unavailable", false);
    }
    const result = {
      events,
      ...(typeof response.nextToken === "string" ? { next_token: response.nextToken } : {}),
      truncated,
    };
    if (Buffer.byteLength(JSON.stringify({ result })) >= MAX_OUTPUT_BYTES)
      throw new AwsPluginError("unavailable", false);
    return result;
  } catch (error) {
    if (error instanceof AwsPluginError) throw error;
    throw mapAwsError(error, true);
  } finally {
    if (owned && "destroy" in client && typeof client.destroy === "function") client.destroy();
  }
}

/** @param {AwsInvocation} request @param {InvocationOptions} options */
async function deployLambda(request, options) {
  const args = request.args;
  const allowed = new Set([
    "function",
    "region",
    "s3_bucket",
    "s3_key",
    "s3_object_version",
    "publish",
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new AwsPluginError("validation");
  if (
    typeof args.function !== "string" ||
    !FUNCTION_NAME.test(args.function) ||
    args.function !== request.scope ||
    typeof args.region !== "string" ||
    !REGION.test(args.region) ||
    typeof args.s3_bucket !== "string" ||
    args.s3_bucket.length < 3 ||
    args.s3_bucket.length > 63 ||
    !BUCKET_NAME.test(args.s3_bucket) ||
    typeof args.s3_key !== "string" ||
    args.s3_key.length < 1 ||
    args.s3_key.length > 1_024 ||
    typeof args.s3_object_version !== "string" ||
    args.s3_object_version.length < 1 ||
    args.s3_object_version.length > 1_024 ||
    args.s3_object_version === "null" ||
    (args.publish !== undefined && typeof args.publish !== "boolean")
  ) {
    throw new AwsPluginError("validation");
  }
  const client =
    options.lambdaClient ?? createLambdaClient(args.region, options.env ?? process.env);
  const owned = options.lambdaClient === undefined;
  try {
    const response = await client.send(
      new UpdateFunctionCodeCommand({
        FunctionName: args.function,
        S3Bucket: args.s3_bucket,
        S3Key: args.s3_key,
        S3ObjectVersion: args.s3_object_version,
        Publish: args.publish === true,
      }),
    );
    if (!response.FunctionArn || !response.CodeSha256 || !response.LastModified)
      throw new AwsPluginError("unavailable", false);
    return {
      function_arn: response.FunctionArn,
      ...(response.Version === undefined ? {} : { version: response.Version }),
      code_sha256: response.CodeSha256,
      last_modified: response.LastModified,
    };
  } catch (error) {
    if (error instanceof AwsPluginError) throw error;
    // A Lambda update may have committed even if the response was lost. Never advertise retryability.
    throw mapAwsError(error, false);
  } finally {
    if (owned && "destroy" in client && typeof client.destroy === "function") client.destroy();
  }
}

/** @param {string} value @returns {string} */
function canonicalLogGroupArn(value) {
  const canonical = value.endsWith(":*") ? value.slice(0, -2) : value;
  if (canonical.length > 200 || !LOG_GROUP_ARN.test(canonical))
    throw new AwsPluginError("validation");
  return canonical;
}

/** Limit the encoded JSON string, not just its UTF-8 text, so escaped logs stay within bounds. */
/** @param {string} value @param {number} maxBytes @returns {string} */
function capJsonString(value, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
  const parts = [];
  let encodedBytes = 2;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    const cost =
      character === '"' ||
      character === "\\" ||
      character === "\b" ||
      character === "\f" ||
      character === "\n" ||
      character === "\r" ||
      character === "\t"
        ? 2
        : point <= 0x1f || (point >= 0xd800 && point <= 0xdfff)
          ? 6
          : Buffer.byteLength(character);
    if (encodedBytes + cost > maxBytes) break;
    parts.push(character);
    encodedBytes += cost;
  }
  return parts.join("");
}

/** @param {string} region @param {NodeJS.ProcessEnv} env @returns {CloudWatchLogsClient} */
function createLogsClient(region, env) {
  return new CloudWatchLogsClient({ region, maxAttempts: 1, credentials: readCredentials(env) });
}

/** @param {string} region @param {NodeJS.ProcessEnv} env @returns {LambdaClient} */
function createLambdaClient(region, env) {
  return new LambdaClient({ region, maxAttempts: 1, credentials: readCredentials(env) });
}

/** @param {NodeJS.ProcessEnv} env */
function readCredentials(env) {
  const accessKeyId = env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
  const sessionToken = env["AWS_SESSION_TOKEN"];
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new AwsPluginError("forbidden");
  return { accessKeyId, secretAccessKey, sessionToken };
}

/** @param {unknown} error @param {boolean} readOnly */
function mapAwsError(error, readOnly) {
  const name = isRecord(error) && typeof error.name === "string" ? error.name : "";
  if (/AccessDenied|Unauthorized|Forbidden/i.test(name)) return new AwsPluginError("forbidden");
  if (/ResourceNotFound|ResourceNotFoundException/i.test(name))
    return new AwsPluginError("not_found");
  if (readOnly && /Throttl|TooManyRequests/i.test(name))
    return new AwsPluginError("rate_limited", true);
  return new AwsPluginError("unavailable", false);
}

/** @returns {Promise<unknown>} */
async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new AwsPluginError("validation");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AwsPluginError("validation");
  }
}

async function main() {
  try {
    const input = await readRequest();
    const invocation = isRecord(input) ? input.invocation : undefined;
    const result = await handleAwsInvocation(/** @type {AwsInvocation} */ (invocation));
    stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    const failure = error instanceof AwsPluginError ? error : new AwsPluginError("unavailable");
    stdout.write(
      `${JSON.stringify({ error: { code: failure.code, retryable: failure.retryable } })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
