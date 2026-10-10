/** The encrypted secret fields persisted for one room integration. */
export interface EncryptedSecret {
  version: 1;
  iv: string;
  ciphertext: string;
  tag: string;
  /** KMS-wrapped room data key; null for the config-keyed development provider. */
  wrapped_data_key: string | null;
}

/** Infrastructure port for room-scoped envelope encryption (§21.5). */
export interface SecretStore {
  seal(
    roomId: string,
    provider: string,
    plaintext: string,
    wrappedDataKey?: string | null,
  ): Promise<EncryptedSecret>;
  open(roomId: string, provider: string, encrypted: EncryptedSecret): Promise<string>;
}
