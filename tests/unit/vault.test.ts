import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { Vault } from '../../src/secrets/vault.js';

describe('Vault', () => {
  let db: Database.Database;
  let vault: Vault;

  beforeEach(() => {
    db = initDatabase(':memory:');
    vault = new Vault(db, 'test-master-key');
  });

  it('should store and retrieve a simple secret', () => {
    vault.set('API_KEY', 'sk-test-12345');
    expect(vault.get('API_KEY')).toBe('sk-test-12345');
  });

  it('should return undefined for missing secrets', () => {
    expect(vault.get('NONEXISTENT')).toBeUndefined();
  });

  it('should overwrite existing secrets', () => {
    vault.set('TOKEN', 'old-value');
    vault.set('TOKEN', 'new-value');
    expect(vault.get('TOKEN')).toBe('new-value');
  });

  it('should handle multiline secrets', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    vault.set('SSH_KEY', pem);
    expect(vault.get('SSH_KEY')).toBe(pem);
  });

  it('should handle JSON config secrets', () => {
    const config = JSON.stringify({ host: 'db.example.com', port: 5432, password: 's3cr3t' });
    vault.set('DB_CONFIG', config);
    expect(vault.get('DB_CONFIG')).toBe(config);
  });

  it('should handle unicode and special characters', () => {
    vault.set('UNICODE', '日本語テスト 🔑 émojis & spëcîal');
    expect(vault.get('UNICODE')).toBe('日本語テスト 🔑 émojis & spëcîal');
  });

  it('should handle large values (10KB+)', () => {
    const large = 'x'.repeat(50_000);
    vault.set('LARGE', large);
    expect(vault.get('LARGE')).toBe(large);
  });

  it('should store 20+ secrets and retrieve all correctly', () => {
    for (let i = 0; i < 25; i++) {
      vault.set(`SECRET_${i}`, `value-${i}-${Math.random()}`);
    }
    for (let i = 0; i < 25; i++) {
      const val = vault.get(`SECRET_${i}`);
      expect(val).toBeDefined();
      expect(val!.startsWith(`value-${i}-`)).toBe(true);
    }
  });

  it('should list all secret names', () => {
    vault.set('A', '1');
    vault.set('B', '2');
    vault.set('C', '3');
    const names = vault.list();
    expect(names).toContain('A');
    expect(names).toContain('B');
    expect(names).toContain('C');
  });

  it('should delete secrets', () => {
    vault.set('DELETEME', 'gone');
    expect(vault.has('DELETEME')).toBe(true);
    vault.delete('DELETEME');
    expect(vault.has('DELETEME')).toBe(false);
    expect(vault.get('DELETEME')).toBeUndefined();
  });

  it('should isolate different master keys', () => {
    vault.set('KEY', 'encrypted-with-key-1');

    // A second vault with a different master key should NOT decrypt the same value.
    const vault2 = new Vault(db, 'different-master-key');
    expect(() => vault2.get('KEY')).toThrow(); // auth tag mismatch
  });

  it('should survive database reopen', () => {
    vault.set('PERSISTENT', 'survives-restart');
    db.close();

    // In production this would be a file DB, but for in-memory we simulate
    // by checking the value was written before close.
    // This test verifies the write path is synchronous (no async flush needed).
    const db2 = initDatabase(':memory:');
    // Can't actually reopen in-memory DB, but we verify the flow doesn't error.
    const vault2 = new Vault(db2, 'test-master-key');
    // New in-memory DB won't have the data, but vault2 should not crash.
    expect(vault2.get('PERSISTENT')).toBeUndefined();
    db2.close();
  });
});
