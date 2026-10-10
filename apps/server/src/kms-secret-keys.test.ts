import { describe, expect, it } from "vitest";
import { KmsRoomDataKeyProvider, type KmsDataKeyOperations } from "./kms-secret-keys.js";
import { EnvelopeSecretStore } from "./secret-store.js";

describe("KMS-backed room data keys", () => {
  it("generates a wrapped key with the room context and unwraps it only for that room", async () => {
    const plaintext = Buffer.alloc(32, 12);
    const ciphertext = Buffer.from("kms-ciphertext");
    const calls: Array<{ operation: string; input: unknown }> = [];
    const operations: KmsDataKeyOperations = {
      async generateDataKey(input) {
        calls.push({ operation: "generate", input });
        return { plaintext: Buffer.from(plaintext), ciphertext };
      },
      async decryptDataKey(input) {
        calls.push({ operation: "decrypt", input });
        if (JSON.stringify(input.EncryptionContext) !== JSON.stringify({ room_id: "room_alpha" })) {
          throw new Error("wrong encryption context");
        }
        return { plaintext: Buffer.from(plaintext) };
      },
    };
    const store = new EnvelopeSecretStore(new KmsRoomDataKeyProvider(operations, "alias/test"));
    const envelope = await store.seal("room_alpha", "github", "credential");

    expect(envelope.wrapped_data_key).toBe(ciphertext.toString("base64url"));
    expect(await store.open("room_alpha", "github", envelope)).toBe("credential");
    expect(calls).toEqual([
      {
        operation: "generate",
        input: {
          KeyId: "alias/test",
          KeySpec: "AES_256",
          EncryptionContext: { room_id: "room_alpha" },
        },
      },
      {
        operation: "decrypt",
        input: {
          CiphertextBlob: ciphertext,
          KeyId: "alias/test",
          EncryptionContext: { room_id: "room_alpha" },
        },
      },
    ]);
  });

  it("fails closed for an empty KMS key id, malformed wrapped keys, and invalid data keys", async () => {
    const operations: KmsDataKeyOperations = {
      async generateDataKey() {
        return { plaintext: Buffer.alloc(8), ciphertext: Buffer.from("wrapped") };
      },
      async decryptDataKey() {
        return { plaintext: Buffer.alloc(8) };
      },
    };
    expect(() => new KmsRoomDataKeyProvider(operations, " ")).toThrow(/key id/);
    const provider = new KmsRoomDataKeyProvider(operations, "alias/test");
    await expect(provider.get("room_alpha")).rejects.toThrow(/invalid data key/);
    await expect(provider.get("room_alpha", "not base64!")).rejects.toThrow(
      /wrapped integration key/,
    );
  });
});
