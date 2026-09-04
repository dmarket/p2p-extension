import { describe, expect, it } from 'vitest';
import { describeError, MESSAGE_MAX, STACK_MAX } from '@/infra/report/describe';

// The core-error ALLOWLIST — the reason this module exists. A Kotlin/JS exception message can embed an
// entire HTTP response body (kotlinx-serialization appends the decoded input; data classes print every
// field), and the generated .d.mts types the whole core surface as opaque strings — so a core that grows
// a field ships it here with no compile error on either side. A core-origin message is therefore reduced
// to a shape WE choose (class + message head + parseable status), never filtered with patterns we hope
// are complete. Denylist scrubbing (redact.test.ts) is the second layer, not this one.

/** An Error whose stack is under our control (the property is writable). */
function withStack(message: string, stack: string): Error {
  const e = new Error(message);
  e.stack = stack;
  return e;
}

const CORE_STACK = [
  'ClientRequestException: whatever',
  '    at sendHeartbeat (ext://node_modules/@dmarket/p2p-tracker-core/p2p-tracker-core.mjs:9046:12)',
  '    at runOnce (ext://background.js:31:100)',
].join('\n');

describe('core-origin messages are ALLOWLISTED, not scrubbed', () => {
  it('reduces a Ktor message embedding a full response body to class + head + status', () => {
    // The headline case: everything after the first delimiter — including the entire quoted body and
    // the tokened URL — must be GONE, not merely <redacted>.
    const raw =
      'ClientRequestException: Client request(POST https://api.dmarket.com/heartbeat?access_token=eyJx.eyJy.zz) ' +
      'invalid: 401 Unauthorized. Text: "{"steam_credential":"SECRET-BODY","deals":[…]}"';
    const d = describeError(withStack(raw, CORE_STACK), 'background');

    expect(d.fromCore).toBe(true);
    expect(d.message).toContain('ClientRequestException');
    expect(d.message).toContain('status=401');
    expect(d.message).not.toContain('SECRET-BODY');
    expect(d.message).not.toContain('access_token');
    expect(d.message).not.toContain('https://'); // the URL sits past the first `(` — cut, not kept
    expect(d.message.startsWith('core: ')).toBe(true);
  });

  it('cuts at the delimiters that introduce interpolated data (paren, quote, brace, bracket, newline)', () => {
    for (const [raw, kept] of [
      ['IllegalStateException: proving failed {"nonce":"n1"}', 'proving failed'],
      ["SerializationException: Unexpected JSON 'token'", 'Unexpected JSON'],
      // 7-digit ids: a 3-digit one starting 1-5 would be (correctly) read back out as an HTTP status.
      ['IllegalArgumentException: bad ids [7778881, 7778882]', 'bad ids'],
    ] as const) {
      const d = describeError(withStack(raw, CORE_STACK), 'background');
      expect(d.message).toContain(kept);
      expect(d.message).not.toMatch(/nonce|n1|'token'|7778881/);
    }
  });

  it('what survives the allowlist cut still passes through the denylist scrub', () => {
    // A second colon does NOT cut (the split set is paren/quote/brace/bracket/newline), so a value
    // interpolated after one reaches the second layer — which is why redaction always runs on the
    // allowlisted head too. A real-shaped JWT there must come out as a marker, not verbatim.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
    const d = describeError(withStack(`IllegalArgumentException: bad value: ${jwt}`, CORE_STACK), 'background');
    expect(d.message).toContain('bad value');
    expect(d.message).not.toContain('eyJ');
  });

  it('reduces a core stack to frame locations, keeping only the class of a Caused by line', () => {
    const stack = [
      'HttpStatusException: POST /heartbeat failed with 500 and body {"secret":"S"}',
      '    at mapStatus (ext://p2p-tracker-core.mjs:100:1)',
      'Caused by: SerializationException: Unexpected JSON token at path $.secret: "LEAKED"',
      '    at decode (ext://kotlinx-serialization.mjs:50:2)',
    ].join('\n');
    const d = describeError(withStack('HttpStatusException: x', stack), 'background');

    expect(d.stack).toContain('at mapStatus');
    expect(d.stack).toContain('at decode');
    expect(d.stack).toContain('Caused by: SerializationException');
    expect(d.stack).not.toContain('LEAKED');
    expect(d.stack).not.toContain('secret');
  });

  it('forceCore classifies core even when no frame names the core', () => {
    const d = describeError(
      withStack('SomeException: detail {"body":"B"}', '    at anon (ext://background.js:1:1)'),
      'background',
      true,
    );
    expect(d.fromCore).toBe(true);
    expect(d.message).not.toContain('"B"');
  });

  it('classifies by stack content: a kotlin/ktor/core frame makes it core-origin', () => {
    for (const frame of [
      'at f (ext://node_modules/@dmarket/p2p-tracker-core/x.mjs:1:1)',
      'at io.ktor.client.request (ext://x.mjs:1:1)',
      'at kotlinx.coroutines.resume (ext://x.mjs:1:1)',
    ]) {
      expect(describeError(withStack('E: m', frame), 'background').fromCore).toBe(true);
    }
  });
});

describe('extension-origin errors keep their (redacted) message', () => {
  it('keeps the full message, scrubbed by the denylist rather than allowlisted', () => {
    const d = describeError(
      withStack(
        'fetch failed for https://api.dmarket.com/x?deviceId=abc — token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
        '    at fetchWrap (ext://background.js:2:2)',
      ),
      'background',
    );
    expect(d.fromCore).toBe(false);
    expect(d.message).toContain('fetch failed'); // NOT reduced to a class name
    expect(d.message).toContain('deviceId=<redacted>'); // query value scrubbed, name kept
    expect(d.message).not.toContain('eyJ');
  });

  it('describes non-Error throws through the extraction ladder', () => {
    expect(describeError('plain string', 'popup').message).toBe('plain string');
    expect(describeError(null, 'popup').message).toBe('Unknown error');
    expect(describeError({ message: 'from object' }, 'popup').message).toBe('from object');
    expect(describeError({ code: 7 }, 'popup').message).toBe('{"code":7}');
  });
});

describe('fingerprints and caps', () => {
  it('failures differing only in numbers / hex runs / whitespace share one fingerprint', () => {
    // Bare numbers only: `\b\d+\b` needs a word boundary, so `5000ms` (digits glued to letters) is
    // deliberately NOT collapsed — that unit suffix is part of the failure's identity.
    const at = '    at f (ext://background.js:1:1)';
    const a = describeError(withStack('timeout after 5000 ms for deal 0577e9d2aa', at), 'background');
    const b = describeError(withStack('timeout after  60000 ms for deal 99aabbccdd', at), 'background');
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('the context is part of the fingerprint, so the same error in two contexts stays distinct', () => {
    const e = () => withStack('same error', '    at f (ext://x.js:1:1)');
    expect(describeError(e(), 'background').fingerprint).not.toBe(describeError(e(), 'popup').fingerprint);
  });

  it('caps message and stack AFTER scrubbing (a cap landing mid-token would defeat every rule)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    const d = describeError(
      withStack(`x ${jwt} ${'y'.repeat(MESSAGE_MAX * 2)}`, `    at f (ext://x.js:1:1)\n${'z'.repeat(STACK_MAX * 2)}`),
      'background',
    );
    expect(d.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(d.stack!.length).toBeLessThanOrEqual(STACK_MAX);
    expect(d.message).not.toContain('eyJ');
  });
});
