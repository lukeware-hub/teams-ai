import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientHeader } from '../../server/license/client.js';

describe('license client header', () => {
  it('seals the Teams AI key and the time so only the private key opens it', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Date.UTC(2026, 9, 16, 12);
    const header = clientHeader(now, publicKey);
    const opened = JSON.parse(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header, 'base64')).toString('utf8')) as { k: string; t: number };
    expect(opened.k).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.t).toBe(now / 1000);
    expect(clientHeader(now, publicKey)).not.toBe(header);
    expect(header).not.toContain(opened.k);
  });
});
