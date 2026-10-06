import type { Pool } from "@crossover/db";
import { toHttpError } from "@crossover/gateway";
import { authenticate, type Dispatcher } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import type { Principal } from "@crossover/kernel";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MCP_TOOLS, type McpToolDefinition } from "./tools.js";

export interface McpOptions {
  dispatcher: Dispatcher;
  pool: Pool;
  /** Tools to offer; default {@link MCP_TOOLS}. */
  tools?: readonly McpToolDefinition[];
  /** Route path; default `/mcp`. */
  path?: string;
}

const BEARER = /^Bearer ([^\s]+)$/i;

function bearer(request: FastifyRequest): string {
  const match = request.headers.authorization ? BEARER.exec(request.headers.authorization) : null;
  if (!match?.[1]) throw new CrossoverError("UNAUTHENTICATED", "Missing or invalid bearer token");
  return match[1];
}

/** A fresh MCP server for one authenticated agent, with one tool per definition. */
export function buildMcpServer(
  dispatcher: Dispatcher,
  principal: Principal,
  tools: readonly McpToolDefinition[],
): McpServer {
  const server = new McpServer({ name: "crossover", version: "0.0.0" });
  for (const tool of tools) {
    const input = tool.mutating
      ? { ...tool.input, idempotency_key: z.string().min(1).max(128).optional() }
      : tool.input;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: input },
      async (args: Record<string, unknown>) => {
        const { idempotency_key, ...rest } = args;
        try {
          const result = await dispatcher.dispatch(principal, {
            id: newId("cmd"),
            method: tool.method,
            params: tool.toParams ? tool.toParams(rest) : rest,
            ...(tool.mutating
              ? {
                  idempotency_key:
                    typeof idempotency_key === "string" ? idempotency_key : newId("cmd"),
                }
              : {}),
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result.response) }] };
        } catch (error) {
          // The tool failed, not the protocol: report the §16.3 body so the agent can react.
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(toHttpError(error).body) }],
          };
        }
      },
    );
  }
  return server;
}

/**
 * Serve the MCP server (T707) on `POST /mcp` of a Fastify app, Streamable HTTP, stateless:
 * every request is authenticated with the participant's room access token (`Authorization:
 * Bearer at_…`, the same one REST uses) and gets a server holding exactly that principal, so
 * nothing about one agent can leak into another's session. A missing or bad token is 401 with
 * the §16.3 error body before any MCP handling happens.
 */
export function registerMcp(app: FastifyInstance, options: McpOptions): void {
  const tools = options.tools ?? MCP_TOOLS;
  const path = options.path ?? "/mcp";

  app.post(path, async (request, reply) => {
    let principal: Principal;
    try {
      principal = await authenticate(options.pool, bearer(request));
    } catch (error) {
      // Before any MCP handling: a plain HTTP answer in the §16.3 shape.
      const mapped = toHttpError(error);
      if (mapped.status === 401) void reply.header("WWW-Authenticate", "Bearer");
      return reply.status(mapped.status).header("Cache-Control", "no-store").send(mapped.body);
    }
    const server = buildMcpServer(options.dispatcher, principal, tools);
    const transport = new StreamableHTTPServerTransport({
      // Stateless: the SDK's own option type doesn't admit `undefined` under our strict flags.
      sessionIdGenerator: undefined,
    } as never);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as never);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: no server-initiated stream to open or session to end.
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(405)
      .header("Allow", "POST")
      .send(new CrossoverError("VALIDATION", "Use POST for MCP requests").toErrorBody());
  app.get(path, notAllowed);
  app.delete(path, notAllowed);
}
