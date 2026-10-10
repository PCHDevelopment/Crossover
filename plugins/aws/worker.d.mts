import type {
  FilterLogEventsCommand,
  FilterLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import type {
  UpdateFunctionCodeCommand,
  UpdateFunctionCodeCommandOutput,
} from "@aws-sdk/client-lambda";

export class AwsPluginError extends Error {
  code: "validation" | "forbidden" | "not_found" | "rate_limited" | "unavailable";
  retryable: boolean;
}

export interface AwsInvocation {
  tool: string;
  scope?: string;
  args: Record<string, unknown>;
}

export interface AwsInvocationOptions {
  logsClient?: {
    send(command: FilterLogEventsCommand): Promise<Partial<FilterLogEventsCommandOutput>>;
  };
  lambdaClient?: {
    send(command: UpdateFunctionCodeCommand): Promise<Partial<UpdateFunctionCodeCommandOutput>>;
  };
  env?: NodeJS.ProcessEnv;
}

export interface AwsReadLogsResult {
  events: { timestamp: number; log_stream: string; message: string }[];
  next_token?: string;
  truncated: boolean;
}

export interface AwsDeployLambdaResult {
  function_arn: string;
  version?: string;
  code_sha256: string;
  last_modified: string;
}

export function handleAwsInvocation(
  invocation: AwsInvocation & { tool: "aws.read_logs" },
  options?: AwsInvocationOptions,
): Promise<AwsReadLogsResult>;
export function handleAwsInvocation(
  invocation: AwsInvocation & { tool: "aws.deploy_lambda" },
  options?: AwsInvocationOptions,
): Promise<AwsDeployLambdaResult>;
export function handleAwsInvocation(
  invocation: AwsInvocation,
  options?: AwsInvocationOptions,
): Promise<AwsReadLogsResult | AwsDeployLambdaResult>;
