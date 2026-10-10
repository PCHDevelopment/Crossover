import type { ToolDefinition, ToolRegistry } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d+$/;
const LOG_GROUP_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):logs:[a-z0-9-]+:\d{12}:log-group:[A-Za-z0-9._/#-]+(?::\*)?$/;

const logGroupArn = z
  .string()
  .min(1)
  .max(200)
  .transform((value, ctx) => {
    try {
      return normalizeLogGroupArn(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid CloudWatch log group ARN" });
      return z.NEVER;
    }
  });

export const awsReadLogsParams = z
  .strictObject({
    log_group_arn: logGroupArn,
    start_time: z.iso.datetime({ offset: true }),
    end_time: z.iso.datetime({ offset: true }),
    filter_pattern: z.string().max(1_024).optional(),
    log_stream_names: z.array(z.string().min(1).max(512)).min(1).max(10).optional(),
    limit: z.number().int().min(1).max(1_000).default(100),
    next_token: z.string().min(1).max(2_048).optional(),
  })
  .superRefine((args, ctx) => {
    const start = Date.parse(args.start_time);
    const end = Date.parse(args.end_time);
    if (end <= start) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "end_time must follow start_time",
      });
    }
    if (end > Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "end_time cannot be in the future",
      });
    }
    if (end - start > 24 * 60 * 60 * 1_000) {
      ctx.addIssue({
        code: "custom",
        path: ["start_time"],
        message: "Log queries are limited to 24 hours",
      });
    }
  });

export const awsDeployLambdaParams = z.strictObject({
  function: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  region: z.string().regex(REGION),
  s3_bucket: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  s3_key: z.string().min(1).max(1_024),
  s3_object_version: z
    .string()
    .min(1)
    .max(1_024)
    .refine((version) => version !== "null"),
  publish: z.boolean().default(false),
});

export function registerAwsTools(registry: ToolRegistry, image: string): void {
  const execution = (regionFrom: "args.region" | "scope.logsArn", service: "lambda" | "logs") => ({
    image,
    command: ["node", "--use-env-proxy", "/app/plugins/aws/worker.mjs"],
    egressHosts: [],
    awsRegionalEgress: { regionFrom, services: [service] },
    integrations: [{ provider: "aws" }],
    maxOutputBytes: 256 * 1024,
  });
  const definitions: ToolDefinition[] = [
    {
      name: "aws.read_logs",
      description: "Read a bounded time range of events from a connected CloudWatch log group.",
      capability: "aws.read_logs",
      tier: 0,
      input: awsReadLogsParams,
      scope: (args) => (args as z.infer<typeof awsReadLogsParams>).log_group_arn,
      normalizeScope: normalizeLogGroupArn,
      idempotent: true,
      execution: execution("scope.logsArn", "logs"),
    },
    {
      name: "aws.deploy_lambda",
      description: "Deploy a versioned S3 ZIP artifact to a Lambda function.",
      capability: "aws.deploy_lambda",
      // One tool definition covers both staging and production; the concrete scope sets the tier.
      tier: 3,
      input: awsDeployLambdaParams,
      scope: (args) => (args as z.infer<typeof awsDeployLambdaParams>).function,
      idempotent: false,
      execution: execution("args.region", "lambda"),
    },
  ];
  for (const definition of definitions)
    if (!registry.get(definition.name)) registry.register(definition);
}

export function normalizeLogGroupArn(value: string): string {
  const canonical = value.endsWith(":*") ? value.slice(0, -2) : value;
  if (canonical.length > 200 || !LOG_GROUP_ARN.test(canonical))
    throw new CrossoverError("VALIDATION", "The arguments name an invalid scope", {
      details: { reason: "invalid_scope" },
    });
  return canonical;
}
