import { describe, expect, it } from "vitest";
import { ToolRegistry, capabilityFor, scopeOf } from "@crossover/kernel";
import { tierOf } from "@crossover/policy";
import {
  awsDeployLambdaParams,
  awsReadLogsParams,
  normalizeLogGroupArn,
  registerAwsTools,
} from "./aws-plugin.js";
import { handleAwsInvocation } from "../../../plugins/aws/worker.mjs";

const IMAGE = `registry.example/crossover-aws-plugin@sha256:${"b".repeat(64)}`;
const LOG_ARN = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/demo";
const VALID_RANGE = {
  start_time: "2025-01-01T00:00:00.000Z",
  end_time: "2025-01-01T01:00:00.000Z",
};

describe("AWS tools", () => {
  it("declares scope-aware deployment and regional, STS-backed execution", () => {
    const registry = new ToolRegistry({ tierOf });
    registerAwsTools(registry, IMAGE);
    const logs = registry.get("aws.read_logs")!;
    const deploy = registry.get("aws.deploy_lambda")!;
    const logArgs = awsReadLogsParams.parse({ log_group_arn: `${LOG_ARN}:*`, ...VALID_RANGE });
    const deployArgs = awsDeployLambdaParams.parse({
      function: "staging-api",
      region: "us-east-1",
      s3_bucket: "release-artifacts",
      s3_key: "builds/api.zip",
      s3_object_version: "v-01",
    });

    expect(normalizeLogGroupArn(`${LOG_ARN}:*`)).toBe(LOG_ARN);
    expect(logArgs.log_group_arn).toBe(LOG_ARN);
    expect(scopeOf(logs, logArgs)).toBe(LOG_ARN);
    expect(capabilityFor(deploy, deployArgs)).toBe("aws.deploy_lambda:staging-api");
    expect(tierOf(capabilityFor(deploy, deployArgs))).toBe(2);
    expect(deploy.tier).toBe(3); // tool listing and registry validation use the worst case
    expect(deploy.idempotent).toBe(false);
    expect(logs.execution).toMatchObject({
      awsRegionalEgress: { regionFrom: "scope.logsArn", services: ["logs"] },
      integrations: [{ provider: "aws" }],
      maxOutputBytes: 256 * 1024,
    });
    expect(deploy.execution).toMatchObject({
      awsRegionalEgress: { regionFrom: "args.region", services: ["lambda"] },
      command: ["node", "--use-env-proxy", "/app/plugins/aws/worker.mjs"],
      integrations: [{ provider: "aws" }],
    });
  });

  it("validates CloudWatch windows, scope length, streams, and page bounds", () => {
    expect(() =>
      awsReadLogsParams.parse({ log_group_arn: LOG_ARN, ...VALID_RANGE, limit: 1_001 }),
    ).toThrow();
    expect(() =>
      awsReadLogsParams.parse({
        log_group_arn: LOG_ARN,
        start_time: "2025-01-01T00:00:00Z",
        end_time: "2025-01-02T00:00:01Z",
      }),
    ).toThrow();
    expect(() =>
      awsDeployLambdaParams.parse({
        function: "api",
        region: "us-east-1",
        s3_bucket: "release-artifacts",
        s3_key: "build.zip",
        s3_object_version: "null",
      }),
    ).toThrow();
  });

  it("queries only the scoped CloudWatch log group and bounds returned log data", async () => {
    let input: Record<string, unknown> | undefined;
    const result = await handleAwsInvocation(
      {
        tool: "aws.read_logs",
        scope: LOG_ARN,
        args: {
          log_group_arn: `${LOG_ARN}:*`,
          ...VALID_RANGE,
          limit: 100,
          log_stream_names: ["2025/01/01/api"],
          filter_pattern: "ERROR",
        },
      },
      {
        logsClient: {
          async send(command) {
            input = command.input as unknown as Record<string, unknown>;
            return {
              events: [
                {
                  timestamp: 1_735_689_600_000,
                  logStreamName: "2025/01/01/api",
                  message: "x".repeat(20_000),
                },
              ],
              nextToken: "next-page-token",
            };
          },
        },
      },
    );
    expect(input).toMatchObject({
      logGroupIdentifier: `${LOG_ARN}:*`,
      startTime: Date.parse(VALID_RANGE.start_time),
      endTime: Date.parse(VALID_RANGE.end_time),
      filterPattern: "ERROR",
      logStreamNames: ["2025/01/01/api"],
      limit: 20,
    });
    expect(result).toMatchObject({
      events: [{ timestamp: 1_735_689_600_000, log_stream: "2025/01/01/api" }],
      next_token: "next-page-token",
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(result.events[0]!.message))).toBeLessThanOrEqual(
      8 * 1024,
    );
    expect(Buffer.byteLength(JSON.stringify({ result }))).toBeLessThan(256 * 1024);
  });

  it("keeps the worst-case log page below the serialized output ceiling", async () => {
    const hostileText = '"\\\u0000'.repeat(2_048);
    const result = await handleAwsInvocation(
      {
        tool: "aws.read_logs",
        scope: LOG_ARN,
        args: { log_group_arn: LOG_ARN, ...VALID_RANGE, limit: 1_000 },
      },
      {
        logsClient: {
          async send() {
            return {
              events: Array.from({ length: 20 }, (_, index) => ({
                timestamp: 1_735_689_600_000 + index,
                logStreamName: hostileText,
                message: hostileText,
              })),
              nextToken: "next-page-token",
            };
          },
        },
      },
    );
    expect(result.events).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ result }))).toBeLessThan(256 * 1024);
  });

  it("refuses a log request outside its authorized scope before contacting AWS", async () => {
    let called = false;
    await expect(
      handleAwsInvocation(
        {
          tool: "aws.read_logs",
          scope: LOG_ARN,
          args: {
            log_group_arn: "arn:aws:logs:us-east-1:123456789012:log-group:other",
            ...VALID_RANGE,
          },
        },
        {
          logsClient: {
            async send() {
              called = true;
              return {};
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(called).toBe(false);
  });

  it("deploys the requested immutable artifact and returns only safe metadata", async () => {
    let input: Record<string, unknown> | undefined;
    const result = await handleAwsInvocation(
      {
        tool: "aws.deploy_lambda",
        scope: "staging-api",
        args: {
          function: "staging-api",
          region: "us-east-1",
          s3_bucket: "release-artifacts",
          s3_key: "builds/api.zip",
          s3_object_version: "3HL4kqtJlcpXroDTDmjVBH40Nrjfkd",
          publish: true,
        },
      },
      {
        lambdaClient: {
          async send(command) {
            input = command.input as unknown as Record<string, unknown>;
            return {
              FunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:staging-api",
              Version: "7",
              CodeSha256: "sha256-value",
              LastModified: "2025-01-01T00:00:00.000+0000",
            };
          },
        },
      },
    );
    expect(input).toEqual({
      FunctionName: "staging-api",
      S3Bucket: "release-artifacts",
      S3Key: "builds/api.zip",
      S3ObjectVersion: "3HL4kqtJlcpXroDTDmjVBH40Nrjfkd",
      Publish: true,
    });
    expect(result).toEqual({
      function_arn: "arn:aws:lambda:us-east-1:123456789012:function:staging-api",
      version: "7",
      code_sha256: "sha256-value",
      last_modified: "2025-01-01T00:00:00.000+0000",
    });
  });
});
