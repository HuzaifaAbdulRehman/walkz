import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import type { PoolClient } from 'pg';
import { z } from 'zod';

const credentialValueSchema = z.string().min(1).max(16_384);
const keyIdSchema = z.string().trim().min(1).max(128);
const base64KeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'Encryption keys must be 32-byte base64 values.');

export const credentialEncryptionConfigSchema = z
  .object({
    activeKeyId: keyIdSchema,
    keys: z.record(keyIdSchema, base64KeySchema),
  })
  .strict()
  .superRefine((config, context) => {
    if (!(config.activeKeyId in config.keys)) {
      context.addIssue({
        code: 'custom',
        message: 'The active encryption key must be configured.',
        path: ['activeKeyId'],
      });
    }
  });

export interface CredentialVault {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface EncryptedCredential {
  encryptionKeyId: string;
  encryptedValue: Buffer;
}

const encryptedCredentialSchema = z
  .object({
    encryptionKeyId: keyIdSchema,
    encryptedValue: z.instanceof(Buffer).refine((value) => value.length >= 30, {
      message: 'Encrypted credentials must include an envelope.',
    }),
  })
  .strict();

const credentialStorageInputSchema = z
  .object({
    repositoryId: z.uuid(),
    provider: z.string().trim().min(1).max(128),
    credential: credentialValueSchema,
  })
  .strict();

const envelopeVersion = 1;
const nonceLength = 12;
const authTagLength = 16;

export function createCredentialVault(input: unknown): CredentialVault {
  const config = credentialEncryptionConfigSchema.parse(input);
  const keys = new Map(
    Object.entries(config.keys).map(([keyId, encodedKey]) => [
      keyId,
      Buffer.from(encodedKey, 'base64'),
    ]),
  );
  return { activeKeyId: config.activeKeyId, keys };
}

export function encryptCredential(
  vault: CredentialVault,
  input: unknown,
): EncryptedCredential {
  const credential = credentialValueSchema.parse(input);
  const key = vault.keys.get(vault.activeKeyId);
  if (key === undefined) {
    throw new Error('The active encryption key is unavailable.');
  }

  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(credential, 'utf8'), cipher.final()]);
  const envelope = Buffer.concat([
    Buffer.from([envelopeVersion]),
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]);
  return { encryptionKeyId: vault.activeKeyId, encryptedValue: envelope };
}

export function decryptCredential(
  vault: CredentialVault,
  input: unknown,
): string {
  const encrypted = encryptedCredentialSchema.parse(input);
  const key = vault.keys.get(encrypted.encryptionKeyId);
  if (key === undefined) {
    throw new Error('The credential encryption key is unavailable.');
  }

  const envelope = encrypted.encryptedValue;
  if (envelope[0] !== envelopeVersion) {
    throw new Error('The credential envelope version is unsupported.');
  }

  const nonceStart = 1;
  const authTagStart = nonceStart + nonceLength;
  const ciphertextStart = authTagStart + authTagLength;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      envelope.subarray(nonceStart, authTagStart),
    );
    decipher.setAuthTag(envelope.subarray(authTagStart, ciphertextStart));
    return Buffer.concat([
      decipher.update(envelope.subarray(ciphertextStart)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt the provider credential.');
  }
}

export async function storeProviderCredential(
  client: Pick<PoolClient, 'query'>,
  vault: CredentialVault,
  input: unknown,
): Promise<string> {
  const credential = credentialStorageInputSchema.parse(input);
  const encrypted = encryptCredential(vault, credential.credential);
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO provider_credentials (
        repository_id,
        provider,
        encryption_key_id,
        encrypted_value
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (repository_id, provider) DO UPDATE
      SET encryption_key_id = EXCLUDED.encryption_key_id,
          encrypted_value = EXCLUDED.encrypted_value
      RETURNING id
    `,
    [
      credential.repositoryId,
      credential.provider,
      encrypted.encryptionKeyId,
      encrypted.encryptedValue,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Credential storage did not return an ID.');
  }
  return row.id;
}
