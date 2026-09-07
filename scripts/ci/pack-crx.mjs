#!/usr/bin/env node
// pack-crx.mjs — wrap an already-built extension ZIP into a signed CRX3 for Chrome Web Store
// "Verified CRX Uploads", and verify such a file.
//
//   node scripts/ci/pack-crx.mjs pack   <in.zip> <out.crx>   # env CRX_SIGNING_KEY_B64 = base64(PEM)
//   node scripts/ci/pack-crx.mjs verify <file.crx>           # no key needed
//
// WHY THIS EXISTS. With Verified CRX Uploads opted in (dashboard → Package), the store rejects a plain
// zip from both the dashboard and the API: every package update must be a CRX3 signed with the RSA key
// whose PUBLIC half was registered there. This wraps the EXACT zip the release job published (the bytes
// in the release's SHA256SUMS) — nothing is re-zipped, so what the store receives is provably what was
// built, tested and attached to the GitHub Release.
//
// WHY HAND-ROLLED. The deploy jobs deliberately install nothing (node + curl + coreutils), and the one
// thing this script touches is the signing key — a third-party package on that path is a supply-chain
// surface for exactly the secret Verified CRX Uploads exists to protect. The format is small enough to
// carry here, and the file self-verifies after writing (see `pack`).
//
// FORMAT (Chromium components/crx_file/crx3.proto + crx_creator.cc):
//
//   "Cr24" | uint32 LE version=3 | uint32 LE header length | CrxFileHeader | <the zip, byte for byte>
//
//   message CrxFileHeader {                       // protobuf, hand-encoded below
//     repeated AsymmetricKeyProof sha256_with_rsa = 2;     // { bytes public_key = 1;  bytes signature = 2; }
//     repeated AsymmetricKeyProof sha256_with_ecdsa = 3;   // (not emitted; parsed and skipped)
//     bytes signed_header_data = 10000;                    // serialized SignedData { bytes crx_id = 1; }
//   }
//
//   crx_id    = first 16 bytes of SHA-256(public key as SubjectPublicKeyInfo DER)
//   signature = RSA PKCS#1 v1.5 / SHA-256 over
//               "CRX3 SignedData\0" ‖ uint32 LE len(signed_header_data) ‖ signed_header_data ‖ zip
//
// The signing key is the Verified-CRX-Uploads key, NOT the key behind the store item id: the store
// verifies our signature against the registered public key and then re-signs with its own. So the
// "signing key id" printed here (crx_id of OUR key) is not, and need not be, the extension's store id.
//
// Key material never touches disk and is never printed. `node:crypto` takes the PEM string directly; the
// only outputs about the key are its crx_id and the SHA-256 fingerprint of its SubjectPublicKeyInfo —
// which is what an operator compares with the public key registered in the dashboard:
//   openssl pkey -pubin -in crx-signing.pub.pem -outform DER | shasum -a 256
//
// Exit codes: 0 ok · 1 pack/verify failure · 2 usage or unusable CRX_SIGNING_KEY_B64.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('Cr24', 'latin1');
const CRX_VERSION = 3;
const SIGNED_DATA_PREAMBLE = Buffer.from('CRX3 SignedData\0', 'latin1');
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_END_OF_CENTRAL_DIR = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const MIN_RSA_BITS = 2048;

// Protobuf field numbers (crx3.proto).
const FIELD_SHA256_WITH_RSA = 2;
const FIELD_SHA256_WITH_ECDSA = 3;
const FIELD_SIGNED_HEADER_DATA = 10000;
const FIELD_PROOF_PUBLIC_KEY = 1;
const FIELD_PROOF_SIGNATURE = 2;
const FIELD_SIGNED_DATA_CRX_ID = 1;
const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const CRX_ID_BYTES = 16;

// ── Protobuf primitives ───────────────────────────────────────────────────────────────────────────

/** Unsigned base-128 varint. Field 10000's tag is (10000 << 3) | 2 = 80002 → `82 F1 04`. */
export function encodeVarint(n) {
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`varint out of range: ${n}`);
  }
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

function decodeVarint(buf, offset) {
  let value = 0;
  let mul = 1;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const b = buf[pos++];
    value += (b & 0x7f) * mul;
    if (value > Number.MAX_SAFE_INTEGER) throw new Error('varint too large');
    if ((b & 0x80) === 0) break;
    mul *= 128;
  }
  return { value, next: pos };
}

function lengthDelimited(fieldNumber, bytes) {
  return Buffer.concat([encodeVarint(fieldNumber * 8 + WIRE_LENGTH_DELIMITED), encodeVarint(bytes.length), bytes]);
}

/**
 * Walk a serialized message and hand every field to `onField(fieldNumber, bytes)`. Only wire types 0
 * and 2 occur in crx3.proto; anything else means this is not a CRX header.
 */
function forEachField(buf, onField) {
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    pos = tag.next;
    if (wireType === WIRE_LENGTH_DELIMITED) {
      const len = decodeVarint(buf, pos);
      pos = len.next;
      if (pos + len.value > buf.length) throw new Error(`field ${fieldNumber} runs past the end of the header`);
      onField(fieldNumber, buf.subarray(pos, pos + len.value));
      pos += len.value;
    } else if (wireType === WIRE_VARINT) {
      const v = decodeVarint(buf, pos);
      pos = v.next;
      onField(fieldNumber, v.value);
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType} for field ${fieldNumber}`);
    }
  }
}

// ── CRX3 ──────────────────────────────────────────────────────────────────────────────────────────

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/** The 16-byte id Chrome derives from a public key (SubjectPublicKeyInfo DER). */
export function crxIdFor(spkiDer) {
  return createHash('sha256').update(spkiDer).digest().subarray(0, CRX_ID_BYTES);
}

/** Hex SHA-256 of the SubjectPublicKeyInfo DER — comparable with `openssl pkey -pubin -outform DER | shasum -a 256`. */
export function keyFingerprint(spkiDer) {
  return createHash('sha256').update(spkiDer).digest('hex');
}

function signedInput(signedHeaderData, zip) {
  return Buffer.concat([SIGNED_DATA_PREAMBLE, u32le(signedHeaderData.length), signedHeaderData, zip]);
}

function assertLooksLikeZip(zip) {
  if (zip.length < 22 || !zip.subarray(0, 4).equals(ZIP_LOCAL_FILE_HEADER)) {
    throw new Error('input is not a ZIP archive (no local file header at offset 0)');
  }
  // The end-of-central-directory record sits in the last 22 bytes + up to a 64 KiB comment.
  const tail = zip.subarray(Math.max(0, zip.length - (22 + 0xffff)));
  if (tail.lastIndexOf(ZIP_END_OF_CENTRAL_DIR) === -1) {
    throw new Error('input is not a complete ZIP archive (no end-of-central-directory record)');
  }
}

/**
 * Sign `zip` (a Buffer holding a complete ZIP archive) into a CRX3 with an RSA private key given as PEM
 * (PKCS#1 `RSA PRIVATE KEY` or PKCS#8 `PRIVATE KEY`). Deterministic: PKCS#1 v1.5 has no salt, so the
 * same zip and key always produce the same bytes.
 */
export function packCrx3(zip, privateKeyPem) {
  assertLooksLikeZip(zip);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`signing key must be RSA, got ${key.asymmetricKeyType}`);
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) {
    throw new Error(`signing key is ${bits}-bit RSA; the store requires at least ${MIN_RSA_BITS}`);
  }
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const signedHeaderData = lengthDelimited(FIELD_SIGNED_DATA_CRX_ID, crxIdFor(spki));
  // `sign()` with an RSA key and no padding option is RSA PKCS#1 v1.5 — what crx_creator.cc uses.
  const signature = sign('sha256', signedInput(signedHeaderData, zip), key);
  const proof = Buffer.concat([
    lengthDelimited(FIELD_PROOF_PUBLIC_KEY, spki),
    lengthDelimited(FIELD_PROOF_SIGNATURE, signature),
  ]);
  // Ascending field order, as protoc serializes it: the proof (2) before signed_header_data (10000).
  const header = Buffer.concat([
    lengthDelimited(FIELD_SHA256_WITH_RSA, proof),
    lengthDelimited(FIELD_SIGNED_HEADER_DATA, signedHeaderData),
  ]);
  return Buffer.concat([MAGIC, u32le(CRX_VERSION), u32le(header.length), header, zip]);
}

/**
 * Split a CRX3 into its parts without judging them. Throws on anything that is not structurally a
 * CRX3. Returns `{ rsaProofs: [{publicKey, signature}], ecdsaProofCount, signedHeaderData, crxId, zip }`.
 */
export function parseCrx3(buf) {
  if (buf.length < 12 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('not a CRX file (bad magic)');
  const version = buf.readUInt32LE(4);
  if (version !== CRX_VERSION) throw new Error(`CRX version ${version}; only CRX3 is supported`);
  const headerLength = buf.readUInt32LE(8);
  if (12 + headerLength > buf.length) throw new Error('header length runs past the end of the file');
  const header = buf.subarray(12, 12 + headerLength);
  const zip = buf.subarray(12 + headerLength);

  const rsaProofs = [];
  let ecdsaProofCount = 0;
  let signedHeaderData;
  forEachField(header, (field, bytes) => {
    if (field === FIELD_SHA256_WITH_RSA) {
      const proof = {};
      forEachField(bytes, (f, v) => {
        if (f === FIELD_PROOF_PUBLIC_KEY) proof.publicKey = v;
        else if (f === FIELD_PROOF_SIGNATURE) proof.signature = v;
      });
      if (!proof.publicKey || !proof.signature) throw new Error('an RSA proof is missing its key or signature');
      rsaProofs.push(proof);
    } else if (field === FIELD_SHA256_WITH_ECDSA) {
      ecdsaProofCount += 1;
    } else if (field === FIELD_SIGNED_HEADER_DATA) {
      signedHeaderData = bytes;
    }
  });
  if (!signedHeaderData) throw new Error('header has no signed_header_data');

  let crxId;
  forEachField(signedHeaderData, (f, v) => {
    if (f === FIELD_SIGNED_DATA_CRX_ID) crxId = v;
  });
  if (!crxId || crxId.length !== CRX_ID_BYTES) throw new Error('signed_header_data has no 16-byte crx_id');

  return { rsaProofs, ecdsaProofCount, signedHeaderData, crxId, zip };
}

/**
 * Verify a CRX3 the way the store will: the file must carry an RSA proof whose key hashes to the
 * embedded crx_id AND whose signature covers the header and the zip. Every RSA proof present must
 * verify (a broken extra proof is never fine). Never throws; returns `{ ok, errors, ... }`.
 */
export function verifyCrx3(buf) {
  const errors = [];
  let parsed;
  try {
    parsed = parseCrx3(buf);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const { rsaProofs, ecdsaProofCount, signedHeaderData, crxId, zip } = parsed;
  if (rsaProofs.length === 0) errors.push('no sha256_with_rsa proof');
  try {
    assertLooksLikeZip(zip);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const input = signedInput(signedHeaderData, zip);
  let signingKey;
  rsaProofs.forEach((proof, i) => {
    let valid = false;
    try {
      valid = verify('sha256', input, { key: proof.publicKey, format: 'der', type: 'spki' }, proof.signature);
    } catch (e) {
      errors.push(`proof ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!valid) errors.push(`proof ${i}: signature does not verify`);
    if (crxIdFor(proof.publicKey).equals(crxId)) signingKey = proof.publicKey;
  });
  if (rsaProofs.length > 0 && !signingKey) errors.push('no RSA proof matches the embedded crx_id');

  return {
    ok: errors.length === 0,
    errors,
    crxId: crxId.toString('hex'),
    keyFingerprint: signingKey ? keyFingerprint(signingKey) : undefined,
    rsaProofCount: rsaProofs.length,
    ecdsaProofCount,
    zipLength: zip.length,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const USAGE = [
  'usage: node scripts/ci/pack-crx.mjs pack <in.zip> <out.crx>    (env CRX_SIGNING_KEY_B64)',
  '       node scripts/ci/pack-crx.mjs verify <file.crx>',
].join('\n');

function describe(label, result) {
  return [
    `pack-crx: ${label}`,
    `  zip payload      : ${result.zipLength} bytes`,
    `  rsa proofs       : ${result.rsaProofCount}${result.ecdsaProofCount ? ` (+${result.ecdsaProofCount} ecdsa)` : ''}`,
    `  signing key id   : ${result.crxId}   (crx_id of OUR signing key — not the store item id)`,
    `  key fingerprint  : sha256:${result.keyFingerprint ?? '?'}`,
    '  compare the fingerprint with the public key registered under Package → Verified CRX Uploads:',
    '    openssl pkey -pubin -in crx-signing.pub.pem -outform DER | shasum -a 256',
  ].join('\n');
}

/** Decode `CRX_SIGNING_KEY_B64`; the message on failure names the variable, never its value. */
function signingKeyFromEnv() {
  const raw = process.env.CRX_SIGNING_KEY_B64;
  if (!raw || !raw.trim()) {
    console.error('ERROR: CRX_SIGNING_KEY_B64 is not set (base64 of the Verified-CRX-Uploads private key PEM).');
    process.exit(2);
  }
  const pem = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN')) {
    console.error('ERROR: CRX_SIGNING_KEY_B64 does not decode to a PEM block — store `base64 < key.pem | tr -d "\\n"`.');
    process.exit(2);
  }
  return pem;
}

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'pack' && a && b) {
    const pem = signingKeyFromEnv();
    let crx;
    try {
      crx = packCrx3(readFileSync(a), pem);
    } catch (e) {
      console.error(`ERROR: cannot pack ${a}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    writeFileSync(b, crx);
    // Self-verify what was WRITTEN, not the buffer in memory: this is the artifact that leaves the job.
    const result = verifyCrx3(readFileSync(b));
    if (!result.ok) {
      console.error(`ERROR: ${b} was written but does not verify:\n  - ${result.errors.join('\n  - ')}`);
      process.exit(1);
    }
    console.log(describe(`wrote ${b} (${crx.length} bytes)`, result));
    return;
  }
  if (cmd === 'verify' && a && !b) {
    const result = verifyCrx3(readFileSync(a));
    if (!result.ok) {
      console.error(`ERROR: ${a} is not a valid CRX3:\n  - ${result.errors.join('\n  - ')}`);
      process.exit(1);
    }
    console.log(describe(`${a} verifies`, result));
    return;
  }
  console.error(USAGE);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
