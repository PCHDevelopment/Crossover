import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConfigKeyRoomDataKeyProvider,
  EnvelopeSecretStore,
  type RoomDataKeyProvider,
} from "./secret-store.js";

const key = (byte: number) => Buffer.alloc(32, byte);

describe("integration secret envelopes", () => {
  it("round-trips UTF-8 and uses a fresh nonce for each value", async () => {
    const store = new EnvelopeSecretStore(new ConfigKeyRoomDataKeyProvider(key(7)));
    const first = await store.seal("room_alpha", "oauth:gitlab", "oauth-token-秘密");
    const second = await store.seal("room_alpha", "oauth:gitlab", "oauth-token-秘密");

    expect(await store.open("room_alpha", "oauth:gitlab", first)).toBe("oauth-token-秘密");
    expect(first).toMatchObject({ version: 1, wrapped_data_key: null });
    expect(first.ciphertext).not.toContain("oauth-token");
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it("binds a ciphertext to its room and rejects tampering", async () => {
    const store = new EnvelopeSecretStore(new ConfigKeyRoomDataKeyProvider(key(8)));
    const envelope = await store.seal("room_alpha", "github", "credential-value");

    await expect(store.open("room_beta", "github", envelope)).rejects.toThrow(
      "Integration secret decryption failed",
    );
    await expect(store.open("room_alpha", "aws", envelope)).rejects.toThrow(
      "Integration secret decryption failed",
    );
    const tamperedCiphertext = Buffer.from(envelope.ciphertext, "base64url");
    tamperedCiphertext[0] = tamperedCiphertext[0]! ^ 1;
    await expect(
      store.open("room_alpha", "github", {
        ...envelope,
        ciphertext: tamperedCiphertext.toString("base64url"),
      }),
    ).rejects.toThrow("Integration secret decryption failed");
    await expect(
      store.open("room_alpha", "github", {
        ...envelope,
        tag: Buffer.alloc(16).toString("base64url"),
      }),
    ).rejects.toThrow("Integration secret decryption failed");
  });

  it("derives distinct, stable data keys per room from the configured development key", async () => {
    const provider = new ConfigKeyRoomDataKeyProvider(key(9));
    const a1 = await provider.get("room_alpha");
    const a2 = await provider.get("room_alpha");
    const b = await provider.get("room_beta");

    expect(Buffer.from(a1.key).equals(Buffer.from(a2.key))).toBe(true);
    expect(Buffer.from(a1.key).equals(Buffer.from(b.key))).toBe(false);
    expect(a1.wrappedDataKey).toBeNull();
    expect(() => new ConfigKeyRoomDataKeyProvider(randomBytes(31))).toThrow(/32 bytes/);
  });

  it("uses the KMS-wrapped room key on encrypt and decrypt without exposing key-provider errors", async () => {
    const dataKey = key(10);
    const calls: Array<{ roomId: string; wrappedDataKey?: string | null }> = [];
    const provider: RoomDataKeyProvider = {
      async get(roomId, wrappedDataKey) {
        calls.push({ roomId, ...(wrappedDataKey !== undefined ? { wrappedDataKey } : {}) });
        return { key: Buffer.from(dataKey), wrappedDataKey: wrappedDataKey ?? "kms-wrapped-key" };
      },
    };
    const store = new EnvelopeSecretStore(provider);
    const envelope = await store.seal("room_alpha", "aws", "long-lived-secret");

    expect(envelope.wrapped_data_key).toBe("kms-wrapped-key");
    expect(await store.open("room_alpha", "aws", envelope)).toBe("long-lived-secret");
    expect(calls).toEqual([
      { roomId: "room_alpha" },
      { roomId: "room_alpha", wrappedDataKey: "kms-wrapped-key" },
    ]);

    const broken = new EnvelopeSecretStore({
      async get() {
        throw new Error("sensitive KMS error");
      },
    });
    await expect(broken.seal("room_alpha", "aws", "secret")).rejects.toThrow(
      "Integration secret encryption failed",
    );
  });

  it("rejects malformed envelopes before trying to decode secret content", async () => {
    const store = new EnvelopeSecretStore(new ConfigKeyRoomDataKeyProvider(key(11)));
    await expect(
      store.open("room_alpha", "oauth:gitlab", {
        version: 1,
        iv: "not-base64url!",
        ciphertext: "",
        tag: "AA",
        wrapped_data_key: null,
      }),
    ).rejects.toThrow("Integration secret decryption failed");
  });
});
