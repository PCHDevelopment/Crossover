import type { PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { EncryptedSecret } from "./secret-store.js";

interface IntegrationKeyRow {
  key_strategy: "CONFIG" | "KMS";
  wrapped_data_key: string | null;
}

/** Persist the first room key atomically, then confirm every connector used the same key. */
export async function ensureRoomDataKey(
  client: PoolClient,
  roomId: string,
  encrypted: EncryptedSecret,
): Promise<void> {
  const keyStrategy = encrypted.wrapped_data_key === null ? "CONFIG" : "KMS";
  await client.query(
    `INSERT INTO integration_room_keys (room_id, key_strategy, wrapped_data_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (room_id) DO NOTHING`,
    [roomId, keyStrategy, encrypted.wrapped_data_key],
  );

  const { rows } = await client.query<IntegrationKeyRow>(
    "SELECT key_strategy, wrapped_data_key FROM integration_room_keys WHERE room_id = $1 FOR UPDATE",
    [roomId],
  );
  const current = rows[0];
  if (
    !current ||
    current.key_strategy !== keyStrategy ||
    current.wrapped_data_key !== encrypted.wrapped_data_key
  ) {
    throw new CrossoverError(
      "CONFLICT_VERSION",
      "The room integration key changed; retry connect",
      {
        retryable: true,
        details: { reason: "integration_key_changed" },
      },
    );
  }
}
