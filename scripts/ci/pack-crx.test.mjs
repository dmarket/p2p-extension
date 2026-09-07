// Tests for scripts/ci/pack-crx.mjs — the CRX3 packer behind Verified CRX Uploads.
//
// What these prove: the bytes match the CRX3 layout Chromium documents (crx3.proto / crx_creator.cc),
// the zip payload is carried untouched, and the signature covers exactly the documented input — checked
// with node:crypto's own `verify`, not with the packer's `verifyCrx3` alone (which is also exercised,
// including its negatives).
//
// ONE-TIME CROSS-CHECK, not automated (needs a Chrome binary): pack an unpacked build with Chrome
// itself — `<chrome> --pack-extension=.output/chrome-mv3 --pack-extension-key=/tmp/k.pem` — and run
// `node scripts/ci/pack-crx.mjs verify .output/chrome-mv3.crx`. It must verify and report the same
// signing key id as our packer does for the same key. Done 2026-09-06 during implementation; see the
// session notes.
//
// `.test.mjs`, not `.test.ts`: .wxt/tsconfig.json includes `../**/*`, so a TS test here would be
// type-checked by `npm run compile` and could not import a `.mjs` (no allowJs). The plain-JS eslint
// block already covers this file.

import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { crxIdFor, encodeVarint, keyFingerprint, packCrx3, parseCrx3, verifyCrx3 } from './pack-crx.mjs';

// ── A real (stored, uncompressed) zip built by hand, so `unzip -t` would accept it too ─────────────

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
/** Minimal zip with the given files, method "stored". */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, data,
    ]);
    centrals.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBuf,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
}

const PREAMBLE = Buffer.from('CRX3 SignedData\0', 'latin1');

let key; // { privateKey: pem, publicKey: KeyObject, spki: Buffer }
let zip;
let crx;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  key = {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey,
    spki: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
  zip = makeZip({ 'manifest.json': '{"manifest_version":3,"name":"t","version":"1.0.0"}', 'a.js': '//' });
  crx = packCrx3(zip, key.privateKey);
});

describe('encodeVarint', () => {
  it.each([
    [0, '00'],
    [1, '01'],
    [127, '7f'],
    [128, '8001'],
    [300, 'ac02'],
    [80002, '82f104'], // (10000 << 3) | 2 — the signed_header_data tag
  ])('%d → %s', (n, hex) => {
    expect(encodeVarint(n).toString('hex')).toBe(hex);
  });
  it('rejects negatives and non-integers', () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError);
    expect(() => encodeVarint(1.5)).toThrow(RangeError);
  });
});

describe('packCrx3 layout', () => {
  it('starts with Cr24, version 3, and a header length that lands exactly on the zip', () => {
    expect(crx.subarray(0, 4).toString('latin1')).toBe('Cr24');
    expect(crx.readUInt32LE(4)).toBe(3);
    const headerLength = crx.readUInt32LE(8);
    expect(crx.subarray(12 + headerLength).equals(zip)).toBe(true);
  });

  it('carries exactly one RSA proof holding the SPKI of the signing key', () => {
    const parsed = parseCrx3(crx);
    expect(parsed.rsaProofs).toHaveLength(1);
    expect(parsed.ecdsaProofCount).toBe(0);
    expect(parsed.rsaProofs[0].publicKey.equals(key.spki)).toBe(true);
    expect(parsed.rsaProofs[0].signature).toHaveLength(256); // 2048-bit RSA
  });

  it('embeds crx_id = sha256(SPKI)[0..16] inside SignedData{crx_id=1}', () => {
    const parsed = parseCrx3(crx);
    const expected = createHash('sha256').update(key.spki).digest().subarray(0, 16);
    expect(parsed.crxId.equals(expected)).toBe(true);
    expect(parsed.signedHeaderData.equals(Buffer.concat([Buffer.from([0x0a, 0x10]), expected]))).toBe(true);
    expect(crxIdFor(key.spki).equals(expected)).toBe(true);
  });

  it('serializes the proof (field 2) before signed_header_data (field 10000)', () => {
    const header = crx.subarray(12, 12 + crx.readUInt32LE(8));
    expect(header[0]).toBe(0x12); // field 2, length-delimited
    const tail = header.subarray(header.length - 22); // varint(80002)=3 B + varint(18)=1 B + SignedData 18 B
    expect(tail.subarray(0, 4).toString('hex')).toBe('82f10412');
  });

  it("signs exactly 'CRX3 SignedData\\0' ‖ u32le(len) ‖ signed_header_data ‖ zip with PKCS#1 v1.5 / SHA-256", () => {
    const parsed = parseCrx3(crx);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(parsed.signedHeaderData.length);
    const input = Buffer.concat([PREAMBLE, len, parsed.signedHeaderData, zip]);
    expect(verify('sha256', input, key.publicKey, parsed.rsaProofs[0].signature)).toBe(true);
    expect(parsed.signedHeaderData.length).toBe(18);
  });

  it('is deterministic for the same zip and key', () => {
    expect(packCrx3(zip, key.privateKey).equals(crx)).toBe(true);
  });

  it('accepts a PKCS#1 PEM as well as PKCS#8', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    expect(pem).toContain('BEGIN RSA PRIVATE KEY');
    expect(verifyCrx3(packCrx3(zip, pem)).ok).toBe(true);
  });
});

describe('packCrx3 refusals', () => {
  it('refuses input that is not a zip', () => {
    expect(() => packCrx3(Buffer.from('not a zip at all, definitely not one'), key.privateKey)).toThrow(/not a ZIP/);
  });
  it('refuses a zip without an end-of-central-directory record', () => {
    expect(() => packCrx3(zip.subarray(0, zip.length - 22), key.privateKey)).toThrow(/not a complete ZIP/);
  });
  it('refuses a non-RSA key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() => packCrx3(zip, ec)).toThrow(/must be RSA/);
  });
  it('refuses an RSA key shorter than 2048 bits', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() => packCrx3(zip, small)).toThrow(/1024-bit/);
  });
  it('refuses garbage where a PEM should be', () => {
    expect(() => packCrx3(zip, 'nope')).toThrow();
  });
});

describe('verifyCrx3', () => {
  it('accepts what packCrx3 wrote and reports the key fingerprint', () => {
    const r = verifyCrx3(crx);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.crxId).toBe(crxIdFor(key.spki).toString('hex'));
    expect(r.keyFingerprint).toBe(keyFingerprint(key.spki));
    expect(r.keyFingerprint).toBe(createHash('sha256').update(key.spki).digest('hex'));
    expect(r.rsaProofCount).toBe(1);
    expect(r.zipLength).toBe(zip.length);
  });

  it('fails when one byte of the zip payload changes', () => {
    const tampered = Buffer.from(crx);
    tampered[tampered.length - 5] ^= 0x01;
    const r = verifyCrx3(tampered);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/signature does not verify/);
  });

  it('fails when the embedded crx_id is changed (header tamper)', () => {
    const tampered = Buffer.from(crx);
    const headerLength = tampered.readUInt32LE(8);
    tampered[12 + headerLength - 1] ^= 0x01; // last byte of crx_id
    const r = verifyCrx3(tampered);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/does not verify|no RSA proof matches/);
  });

  it('fails when the proof was made by a different key than the one named by crx_id', () => {
    // Splice another key's proof in: re-pack with key B, then transplant A's signed_header_data.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const otherCrx = packCrx3(zip, other);
    const a = parseCrx3(crx);
    const b = parseCrx3(otherCrx);
    // Same length by construction (both 2048-bit, both 18-byte SignedData), so a byte-swap is enough.
    const spliced = Buffer.from(otherCrx);
    const headerLength = spliced.readUInt32LE(8);
    a.signedHeaderData.copy(spliced, 12 + headerLength - 18);
    expect(b.signedHeaderData.length).toBe(18);
    const r = verifyCrx3(spliced);
    expect(r.ok).toBe(false);
  });

  it('rejects non-CRX input without throwing', () => {
    expect(verifyCrx3(Buffer.from('PK\x03\x04 this is a zip, not a crx')).ok).toBe(false);
    expect(verifyCrx3(Buffer.alloc(0)).ok).toBe(false);
    expect(verifyCrx3(Buffer.from('Cr24' + '\x02\x00\x00\x00' + '\x00\x00\x00\x00', 'latin1')).errors[0]).toMatch(/CRX version 2/);
  });

  it('rejects a header whose length runs past the file', () => {
    const bad = Buffer.from(crx.subarray(0, 40));
    expect(verifyCrx3(bad).errors[0]).toMatch(/runs past the end/);
  });
});
