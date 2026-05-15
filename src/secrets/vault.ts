import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Vault — AES-256-GCM encrypted secrets store backed by SQLite.
//
// Master key is derived from a passphrase (env var) via PBKDF2.
// Each secret gets its own random IV. Values are base64-encoded at rest.
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = Buffer.from('hiram-vault-v1');  // static, app-scoped
const KEY_BYTES = 32;

interface SecretRow {
  name: string;
  encrypted: string;
  iv: string;
  tag: string;
  created_at: string;
  updated_at: string;
}

export class Vault {
  private key: Buffer;

  constructor(
    private db: Database.Database,
    masterKey: string,
  ) {
    this.key = crypto.pbkdf2Sync(
      masterKey,
      PBKDF2_SALT,
      PBKDF2_ITERATIONS,
      KEY_BYTES,
      'sha512',
    );
  }

  /** Store or overwrite a secret. */
  set(name: string, value: string): void {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO secrets (name, encrypted, iv, tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           encrypted = excluded.encrypted,
           iv = excluded.iv,
           tag = excluded.tag,
           updated_at = excluded.updated_at`,
      )
      .run(
        name,
        encrypted.toString('base64'),
        iv.toString('base64'),
        tag.toString('base64'),
        now,
        now,
      );
  }

  /** Retrieve and decrypt a secret. Returns undefined if not found. */
  get(name: string): string | undefined {
    const row = this.db
      .prepare(`SELECT * FROM secrets WHERE name = ?`)
      .get(name) as SecretRow | undefined;
    if (!row) return undefined;

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(row.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(row.encrypted, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /** List all secret names (not values). */
  list(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM secrets ORDER BY name`)
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** Check if a secret exists. */
  has(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM secrets WHERE name = ?`)
      .get(name);
    return row !== undefined;
  }

  /** Delete a secret. */
  delete(name: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM secrets WHERE name = ?`)
      .run(name);
    return result.changes > 0;
  }
}
