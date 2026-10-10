import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type DecryptCommandInput,
  type GenerateDataKeyCommandInput,
} from "@aws-sdk/client-kms";
import type { RoomDataKeyProvider } from "./secret-store.js";

const KEY_BYTES = 32;

export interface KmsDataKeyOperations {
  generateDataKey(
    input: GenerateDataKeyCommandInput,
  ): Promise<{ plaintext: Uint8Array | undefined; ciphertext: Uint8Array | undefined }>;
  decryptDataKey(input: DecryptCommandInput): Promise<{ plaintext: Uint8Array | undefined }>;
}

/** The AWS SDK adapter is isolated so tests can exercise the broker with deterministic KMS results. */
export class AwsKmsDataKeyOperations implements KmsDataKeyOperations {
  constructor(private readonly client: KMSClient = new KMSClient({})) {}

  close(): void {
    this.client.destroy();
  }

  async generateDataKey(input: GenerateDataKeyCommandInput) {
    const result = await this.client.send(new GenerateDataKeyCommand(input));
    return { plaintext: result.Plaintext, ciphertext: result.CiphertextBlob };
  }

  async decryptDataKey(input: DecryptCommandInput) {
    const result = await this.client.send(new DecryptCommand(input));
    return { plaintext: result.Plaintext };
  }
}

/** KMS wraps each room's stable AES-256 data key; the wrapped key is stored with its integration rows. */
export class KmsRoomDataKeyProvider implements RoomDataKeyProvider {
  constructor(
    private readonly operations: KmsDataKeyOperations,
    private readonly keyId: string,
  ) {
    if (!keyId.trim()) throw new Error("Integration KMS key id must be nonempty");
  }

  async get(
    roomId: string,
    wrappedDataKey?: string | null,
  ): Promise<{
    key: Uint8Array;
    wrappedDataKey: string;
  }> {
    if (!roomId || roomId.length > 100) throw new Error("Invalid integration room id");
    const EncryptionContext = { room_id: roomId };
    if (wrappedDataKey !== undefined && wrappedDataKey !== null) {
      const ciphertext = decode(wrappedDataKey);
      const result = await this.operations.decryptDataKey({
        CiphertextBlob: ciphertext,
        KeyId: this.keyId,
        EncryptionContext,
      });
      try {
        return { key: requireDataKey(result.plaintext), wrappedDataKey };
      } finally {
        result.plaintext?.fill(0);
      }
    }

    const result = await this.operations.generateDataKey({
      KeyId: this.keyId,
      KeySpec: "AES_256",
      EncryptionContext,
    });
    try {
      if (!result.ciphertext) throw new Error("KMS did not return a wrapped integration key");
      return {
        key: requireDataKey(result.plaintext),
        wrappedDataKey: Buffer.from(result.ciphertext).toString("base64url"),
      };
    } finally {
      result.plaintext?.fill(0);
    }
  }
}

function requireDataKey(value: Uint8Array | undefined): Buffer {
  if (!value || value.byteLength !== KEY_BYTES) throw new Error("KMS returned an invalid data key");
  return Buffer.from(value);
}

function decode(value: string): Buffer {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== value) {
    throw new Error("Invalid wrapped integration key");
  }
  return bytes;
}
