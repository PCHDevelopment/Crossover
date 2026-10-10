import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { EncryptedSecret, SecretStore } from "@crossover/kernel";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;
const KDF_INFO = "crossover/integrations/room-data-key/v1";

/** Supplies one stable data key per room. Production providers wrap it with the configured KMS key. */
export interface RoomDataKeyProvider {
  get(
    roomId: string,
    wrappedDataKey?: string | null,
  ): Promise<{
    key: Uint8Array;
    wrappedDataKey: string | null;
  }>;
}

/**
 * Development key provider. HKDF derives a stable, room-specific data key from an operator-supplied
 * 32-byte configuration key; production must use a KMS-backed provider instead.
 */
export class ConfigKeyRoomDataKeyProvider implements RoomDataKeyProvider {
  private readonly masterKey: Buffer;

  constructor(configKey: Uint8Array) {
    if (configKey.byteLength !== KEY_BYTES) {
      throw new Error("Integration encryption key must be 32 bytes");
    }
    this.masterKey = Buffer.from(configKey);
  }

  async get(
    roomId: string,
    wrappedDataKey?: string | null,
  ): Promise<{
    key: Uint8Array;
    wrappedDataKey: null;
  }> {
    if (!roomId || (wrappedDataKey !== undefined && wrappedDataKey !== null)) {
      throw new Error("Development integration key configuration is invalid");
    }
    const salt = Buffer.from(roomId, "utf8");
    return {
      key: Buffer.from(hkdfSync("sha256", this.masterKey, salt, KDF_INFO, KEY_BYTES)),
      wrappedDataKey: null,
    };
  }
}

/** AES-GCM envelope operations shared by the development and KMS key providers. */
export class EnvelopeSecretStore implements SecretStore {
  constructor(private readonly keys: RoomDataKeyProvider) {}

  async seal(
    roomId: string,
    provider: string,
    plaintext: string,
    wrappedDataKey?: string | null,
  ): Promise<EncryptedSecret> {
    validateRoomId(roomId);
    validateProvider(provider);
    let key: Buffer | undefined;
    let suppliedKey: Uint8Array | undefined;
    try {
      const dataKey = await this.keys.get(roomId, wrappedDataKey);
      validateDataKey(dataKey.key);
      suppliedKey = dataKey.key;
      key = Buffer.from(dataKey.key);
      suppliedKey.fill(0);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(associatedData(roomId, provider));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        version: ENVELOPE_VERSION,
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        wrapped_data_key: dataKey.wrappedDataKey,
      };
    } catch {
      throw new Error("Integration secret encryption failed");
    } finally {
      key?.fill(0);
      suppliedKey?.fill(0);
    }
  }

  /**
   * Internal cryptographic primitive; production consumers must read through
   * `readConnectedIntegrationSecretConfig` so status and expiry checks run before decryption.
   */
  async open(roomId: string, provider: string, encrypted: EncryptedSecret): Promise<string> {
    validateRoomId(roomId);
    validateProvider(provider);
    let key: Buffer | undefined;
    let suppliedKey: Uint8Array | undefined;
    try {
      validateEnvelope(encrypted);
      const dataKey = await this.keys.get(roomId, encrypted.wrapped_data_key);
      validateDataKey(dataKey.key);
      suppliedKey = dataKey.key;
      if (dataKey.wrappedDataKey !== encrypted.wrapped_data_key) {
        throw new Error("Integration key envelope mismatch");
      }
      key = Buffer.from(dataKey.key);
      suppliedKey.fill(0);
      const decipher = createDecipheriv("aes-256-gcm", key, decode(encrypted.iv, IV_BYTES));
      decipher.setAAD(associatedData(roomId, provider));
      decipher.setAuthTag(decode(encrypted.tag, TAG_BYTES));
      return Buffer.concat([
        decipher.update(decode(encrypted.ciphertext)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Integration secret decryption failed");
    } finally {
      key?.fill(0);
      suppliedKey?.fill(0);
    }
  }
}

function associatedData(roomId: string, provider: string): Buffer {
  return Buffer.from(
    `crossover:integration-secret:${ENVELOPE_VERSION}:${roomId}:${provider}`,
    "utf8",
  );
}

function validateRoomId(roomId: string): void {
  if (typeof roomId !== "string" || roomId.length < 1 || roomId.length > 100) {
    throw new Error("Invalid integration room id");
  }
}

function validateProvider(provider: string): void {
  if (typeof provider !== "string" || provider.length < 1 || provider.length > 100) {
    throw new Error("Invalid integration provider");
  }
}

function validateDataKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new Error("Invalid integration data key");
  }
}

function validateEnvelope(value: EncryptedSecret): void {
  if (
    !value ||
    value.version !== ENVELOPE_VERSION ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.tag !== "string" ||
    !(value.wrapped_data_key === null || typeof value.wrapped_data_key === "string")
  ) {
    throw new Error("Invalid integration secret envelope");
  }
  decode(value.iv, IV_BYTES);
  decode(value.tag, TAG_BYTES);
  decode(value.ciphertext);
}

function decode(value: string, exactBytes?: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (exactBytes !== undefined && decoded.byteLength !== exactBytes)
  ) {
    throw new Error("Invalid base64url integration secret envelope");
  }
  return decoded;
}
