// Turning a configured endpoint URL into the match pattern that grants access to it.
//
// Consumed by the BUILD (wxt.config.ts, which writes them into `host_permissions`), not by any runtime
// module — they live here rather than inline in the config because the output is a manifest string, which
// is worth a unit test (matchPattern.test.ts) and worth being able to reason about away from the hook that
// writes it. If a runtime caller ever needs the same string — asking for it via `permissions.request`,
// which refuses an origin not listed verbatim in the manifest — it must come from HERE, not be re-spelled.
//
// TWO BREADTHS, one parse. The distinction is real: {@link originMatchPattern} is for a whole site we talk
// to at many paths — and the API/Steam paths are remote-config-tunable, so pinning them in the manifest
// would turn a config hotfix into a store release — while {@link endpointMatchPattern} is for a single
// fixed endpoint, where taking the rest of the host buys nothing. What is NOT a real distinction is how
// they treat a bad value, and they used to differ: the origin form was `new URL(url).origin` unguarded, so
// a typo in a `.env` variable threw a bare `TypeError` from inside the manifest hook, naming neither the
// variable nor the value, while the endpoint form silently contributed nothing. Both now answer
// `undefined`, and wxt.config.ts logs the dropped value — the same "loud but non-fatal" line
// src/background/dev-steam-redirect.ts takes for the same class of mistake.

/** The parse both breadths share. `undefined` for unset, blank, or unparseable. */
function parse(url: string | undefined): URL | undefined {
  const value = url?.trim();
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * The whole origin of `url`: `https://example.com/*`.
 *
 * For a site reached at many paths, or whose paths can change without a release. Anything narrower would
 * have to be kept in step with every path the code (or a remote config) might use.
 *
 * @returns undefined when nothing is configured or the value is not a URL — callers treat that as "this
 *   integration is off", never as "grant everything".
 */
export function originMatchPattern(url: string | undefined): string | undefined {
  const parsed = parse(url);
  return parsed === undefined ? undefined : `${parsed.origin}/*`;
}

/**
 * The narrowest pattern that still covers `url`: `https://example.com/v1/collect*`.
 *
 * A host permission is enforced against the full URL (Chrome's `URLPattern::MatchesURL` matches the path
 * too), so there is no reason to take more of a host than one endpoint uses. The trailing `*` is what keeps
 * a query string matching; without it a `?foo=bar` added later would silently stop matching.
 *
 * A URL with no path degenerates to `<origin>/*` — the same answer {@link originMatchPattern} gives, which
 * is the honest one for a configuration that names no path.
 *
 * @returns undefined on the same terms as {@link originMatchPattern}.
 */
export function endpointMatchPattern(url: string | undefined): string | undefined {
  const parsed = parse(url);
  return parsed === undefined ? undefined : `${parsed.origin}${parsed.pathname}*`;
}
