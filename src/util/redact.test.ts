import { describe, expect, it } from 'vitest';
import { findJwt, redactAndCap, redactSecrets, redactText, REDACTED } from '@/util/redact';

// A syntactically real JWT shape: `eyJ` + two more base64url segments.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3NjU2MSJ9.c2lnbmF0dXJl';
const STEAM_ID = '76561198338780301';
const UUID = '4e67b308-1d2a-4f3b-8c9d-0577e9d2a1b4';
// A DMarket deal id: a 45-char opaque half, a colon, a UUID. The opaque half is exactly what the coarse
// length rule used to eat, leaving `"dealId": "<redacted 45 chars>:…"` in every trade-events response.
const DEAL_ID = `${'a'.repeat(45)}:${UUID}`;

describe('redactText — for text that leaves the machine', () => {
  it('keeps query parameter names and redacts every value', () => {
    expect(redactText('GET https://api.steampowered.com/IEconService/GetTradeOffer/v1/?tradeofferid=93&access_token=secret')).toBe(
      `GET https://api.steampowered.com/IEconService/GetTradeOffer/v1/?tradeofferid=${REDACTED}&access_token=${REDACTED}`,
    );
  });

  it('drops a fragment entirely', () => {
    // `#access_token=…` is a real shape and never diagnostic, so the whole fragment goes — the core's own
    // redactUrl leaves it alone.
    expect(redactText('https://dmarket.com/callback#access_token=secret&state=1')).toBe(
      'https://dmarket.com/callback',
    );
  });

  it('redacts a JWT with no key name in front of it', () => {
    expect(redactText(`Authorization: Bearer ${JWT}`)).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('redacts identity: steamid, uuid, and the per-profile extension origin', () => {
    expect(redactText(`offer for ${STEAM_ID}`)).toBe('offer for <steamid>');
    expect(redactText(`device ${UUID}`)).toBe('device <uuid>');
    expect(redactText('at ext (chrome-extension://abcdefghijklmnop/background.js:1:2)')).toBe(
      'at ext (ext://background.js:1:2)',
    );
  });

  it('redacts a named credential in every shape a body or a captured page uses', () => {
    expect(redactText('sessionid=abc123&partner=1')).toBe(`sessionid=${REDACTED}&partner=1`);
    expect(redactText('{"nonce":"abc123"}')).toBe(`{"nonce":"${REDACTED}"}`);
    expect(redactText(String.raw`{\"auth\":\"abc123\"}`)).toBe(
      String.raw`{\"auth\":\"` + REDACTED + String.raw`\"}`,
    );
    expect(redactText("{'prior': 'abc123'}")).toBe(`{'prior': '${REDACTED}'}`);
    expect(redactText('%22nonce%22%3A%22abc123%22')).toBe(`%22nonce%22%3A%22${REDACTED}%22`);
    // The shape the other four all missed: an unquoted key with a quoted literal, as Steam's own pages
    // spell it. This one shipped a live session id into exported logs.
    expect(redactText('g_sessionID = "abc123";')).toBe(`g_sessionID = "${REDACTED}";`);
  });

  it('scrubs before truncating, and reserves room for the suffix', () => {
    // A cap landing mid-token would leave a fragment matching no rule, so the order is load-bearing.
    const out = redactAndCap(`x=1 ${JWT} yyyyyyyyyy`, 20, ' …');
    expect(out).not.toContain('eyJ');
    expect(out.endsWith(' …')).toBe(true);
    expect(out.length).toBe(20);
  });
});

describe('redactSecrets — for the dev session log, which stays on this machine', () => {
  it('keeps the identifiers a session or wrong-account trace is read from', () => {
    // The whole point of the second mode: `<steamid>` on both sides of a mismatch comparison says nothing.
    expect(redactSecrets(`linked ${STEAM_ID} / token ${STEAM_ID}`)).toBe(
      `linked ${STEAM_ID} / token ${STEAM_ID}`,
    );
    expect(redactSecrets(`?deviceId=${UUID}&partner=1&serverid=1`)).toBe(
      `?deviceId=${UUID}&partner=1&serverid=1`,
    );
  });

  it('keeps a deal id whole, inline and as a pre-split field value', () => {
    expect(redactSecrets(`{"dealId":"${DEAL_ID}"}`)).toBe(`{"dealId":"${DEAL_ID}"}`);
    expect(redactSecrets(`{"assetIds":["${'b'.repeat(45)}"]}`)).toContain('b'.repeat(45));
    // logLifecycle scrubs a value it has already split from its key, so there is no `"dealId":` in the
    // text for the span rule to see — hence the second argument.
    expect(redactSecrets(DEAL_ID, 'dealId')).toBe(DEAL_ID);
  });

  it('keeps a long URL path, so the log still says which endpoint was called', () => {
    const url = 'https://api.dmarket.com/marketplace-api/v1/user-inventory/deals/status';
    expect(redactSecrets(url)).toBe(url);
  });

  it('still redacts credentials, JWTs and unnamed opaque runs', () => {
    expect(redactSecrets('access_token=secret&partner=1')).toBe(`access_token=${REDACTED}&partner=1`);
    expect(redactSecrets('g_sessionID = "abc123";')).toBe(`g_sessionID = "${REDACTED}";`);
    expect(redactSecrets(`Bearer ${JWT}`)).toBe(`Bearer ${REDACTED}`);
    expect(redactSecrets('c'.repeat(60))).toBe('<redacted 60 chars>');
  });

  it('redacts a JWT even under an identifier-shaped key', () => {
    // The identifier exemption only holds a value out of the COARSE length rule; the named rules and the
    // JWT shape rule run before it. Without that ordering the exemption would be a bypass.
    expect(redactSecrets(`{"tokenId":"${JWT}"}`)).toBe(`{"tokenId":"${REDACTED}"}`);
    expect(redactSecrets(JWT, 'dealId')).toBe(REDACTED);
  });
});

describe('findJwt', () => {
  it('is a lookup, not a replacement, and does not carry lastIndex between calls', () => {
    // The dev log DESCRIBES a token (length, decoded exp) instead of disclosing it, and keys off this
    // rule rather than a second copy of the shape. A `g` regex reused with .exec would skip every
    // other call.
    expect(findJwt(`Bearer ${JWT}`)).toBe(JWT);
    expect(findJwt(`Bearer ${JWT}`)).toBe(JWT);
    expect(findJwt('no token here')).toBeNull();
  });
});
