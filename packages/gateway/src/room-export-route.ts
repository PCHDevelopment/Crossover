import type { Pool } from "@crossover/db";
import { authenticate, type Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import type { FastifyInstance } from "fastify";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { bearerToken } from "./bearer.js";
import type { RoomExportLimiter, RoomExportSource } from "./room-export.js";

/**
 * `GET /v1/rooms/:roomId/export` (§5): streams the room's export bundle to its owner or an admin.
 * Moved out of server.ts (T1524) unchanged.
 *
 * Redis (the admission limiter and the per-room lock) must be up: when it is not, the export is
 * refused with `UNAVAILABLE` (503) before anything is streamed; a lock that cannot be released
 * afterwards is logged, and expires on its own TTL.
 */
export function registerRoomExportRoute(
  app: FastifyInstance,
  {
    pool,
    dispatcher,
    roomExport,
  }: {
    pool: Pool;
    dispatcher: Dispatcher;
    roomExport: { source: RoomExportSource; limiter: RoomExportLimiter };
  },
): void {
  app.get<{ Params: { roomId: string } }>("/v1/rooms/:roomId/export", async (request, reply) => {
    const principal = await authenticate(pool, bearerToken(request));
    if (principal.room_id !== request.params.roomId) {
      throw new CrossoverError("NOT_FOUND", "Room not found");
    }
    if (principal.authority !== "OWNER" && principal.authority !== "ADMIN") {
      throw new CrossoverError("FORBIDDEN", "Only room owners and admins may export");
    }

    let release: (() => Promise<void>) | undefined;
    let archive: Awaited<ReturnType<RoomExportSource["create"]>> | undefined;
    let hijacked = false;
    const abort = new AbortController();
    const abortOnDisconnect = () => {
      if (!reply.raw.writableEnded) abort.abort(new Error("Export client disconnected"));
    };
    reply.raw.once("close", abortOnDisconnect);
    const timeout = setTimeout(
      () => abort.abort(new Error("Room export exceeded its time limit")),
      50 * 60_000,
    );
    timeout.unref();
    try {
      try {
        release = await roomExport.limiter.acquire(request.params.roomId, principal.participant_id);
      } catch (error) {
        if (
          error instanceof CrossoverError &&
          error.code === "RATE_LIMITED" &&
          typeof error.details?.["retry_after_ms"] === "number"
        ) {
          reply.header(
            "Retry-After",
            String(Math.ceil(Number(error.details["retry_after_ms"]) / 1000)),
          );
        }
        throw error;
      }
      archive = await roomExport.source.create(request.params.roomId, abort.signal);
      const ledgerHead = archive.ledgerHead;
      reply.hijack();
      hijacked = true;
      reply.raw.statusCode = 200;
      reply.raw.setHeader("Cache-Control", "no-store");
      reply.raw.setHeader("Content-Type", "application/gzip");
      const filename = archive.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      reply.raw.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      let byteCount = 0;
      const countBytes = new Transform({
        transform(chunk: Buffer | string, _encoding, callback) {
          byteCount += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(archive.stream, countBytes, reply.raw, { signal: abort.signal });
        try {
          await dispatcher.runSystem(
            request.params.roomId,
            "room.exported",
            async () => ({
              result: null,
              events: [
                {
                  type: "room.exported",
                  actor_id: principal.participant_id,
                  payload: { byte_count: byteCount, ledger_head: ledgerHead },
                },
              ],
            }),
            { allowReadOnly: true },
          );
        } catch (error) {
          request.log.error(
            { err: error, room_id: request.params.roomId },
            "room export audit failed",
          );
        }
      } catch (error) {
        request.log.error(
          { err: error, room_id: request.params.roomId },
          "room export stream failed",
        );
        if (!reply.raw.destroyed) reply.raw.destroy(error instanceof Error ? error : undefined);
      }
    } catch (error) {
      if (!hijacked) throw error;
    } finally {
      clearTimeout(timeout);
      reply.raw.off("close", abortOnDisconnect);
      if (archive) {
        try {
          await archive.cleanup();
        } catch (error) {
          request.log.error(
            { err: error, room_id: request.params.roomId },
            "room export cleanup failed",
          );
        }
      }
      if (release) {
        try {
          await release();
        } catch (error) {
          request.log.error(
            { err: error, room_id: request.params.roomId },
            "room export lock cleanup failed",
          );
        }
      }
    }
  });
}
