import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TrackerConfig } from '@dmarket/p2p-tracker-core-domain';
import { parseSettings, PUBLISHABLE_TRACKER_FIELDS } from '@/config/settings';
import { REMOTE_CONFIG_PARAM } from '@/infra/remoteConfig';
import { compareVersions, isChromeVersion } from '@/util/version';

// The remote-config documents kept in buckets/<env>/p2p/extension-config.json and published with
// buckets/upload.sh. They list every publishable field with the value in effect, so they are also the one
// place to read what can be tuned. These tests keep them honest:
// - every field is one the overlay really accepts, with a value it really accepts (else it is silently dropped
//   on every client);
// - every publishable field is present, bar the listed exceptions (else the file stops describing the config);
// - where a value differs from the compiled default is pinned below, so a core bump that moves a default fails
//   here instead of being silently overridden by a stale published value.

type Json = Record<string, unknown>;

const read = (env: 'prod' | 'stage'): Json =>
  JSON.parse(readFileSync(`buckets/${env}/p2p/extension-config.json`, 'utf8')) as Json;

/**
 * Fields a file may leave out, and why. The whole `notary` group: its knobs are rollback levers for the prover,
 * published only when one is needed. `notaryUrl` must stay out of the stage file in any case — a published
 * value outranks the dev notary a debug build carries (`resolveNotaryUrl`) — and `maxRecvRecordsOnline`
 * defaults to `null` (keep the prover's own default), which has no number to publish in its place.
 */
const NOTARY_OMITTED = PUBLISHABLE_TRACKER_FIELDS.notary.map((key) => `tracker.notary.${key}`);
const OMITTED: Record<'prod' | 'stage', string[]> = { prod: NOTARY_OMITTED, stage: NOTARY_OMITTED };

/** Deliberate differences from the compiled defaults. Change these together with the files. */
const DEVIATIONS: Record<'prod' | 'stage', Record<string, unknown>> = {
  prod: { 'tracker.cadence.fallbackHeartbeatIntervalMs': 60000 },
  stage: { 'tracker.cadence.fallbackHeartbeatIntervalMs': 60000 },
};

/**
 * The first extension version that reports `pong.update`. Builds before it do not read
 * `web.minExtensionVersion` at all — the FE covers them with its own `forceLegacyExtensionUpdate` flag — so a
 * minimum below this would describe builds that cannot act on it. Raise it only if that first build ships
 * under a different number.
 */
const FIRST_UPDATE_AWARE_VERSION = '1.0.6';

/**
 * Not a tuning deviation: the minimum is an operational value the force-update pipeline raises on every
 * forced release (scripts/ci/force-update.sh), so pinning it next to the deviations would fail every such
 * commit. Checked on its own below instead.
 */
const OPERATIONAL = new Set(['web.minExtensionVersion']);

function leaves(doc: Json): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const tracker = (doc.tracker ?? {}) as Record<string, Json>;
  for (const [group, fields] of Object.entries(tracker)) {
    for (const [key, value] of Object.entries(fields)) out.set(`tracker.${group}.${key}`, value);
  }
  for (const [key, value] of Object.entries((doc.web ?? {}) as Json)) out.set(`web.${key}`, value);
  return out;
}

function defaults(): Map<string, unknown> {
  const core = new TrackerConfig() as unknown as Record<string, Json>;
  const out = new Map<string, unknown>();
  for (const [group, keys] of Object.entries(PUBLISHABLE_TRACKER_FIELDS)) {
    for (const key of keys) out.set(`tracker.${group}.${key}`, core[group]?.[key]);
  }
  for (const [key, value] of Object.entries(parseSettings({}).web)) out.set(`web.${key}`, value);
  return out;
}

describe.each(['prod', 'stage'] as const)('buckets/%s/p2p/extension-config.json', (env) => {
  const doc = read(env);
  const fields = leaves(doc);

  it('has only the document keys the extension reads', () => {
    expect(Object.keys(doc).sort()).toEqual(['tracker', 'web']);
  });

  it('carries only fields the overlay accepts, with values it accepts', () => {
    const parsed = parseSettings({ [REMOTE_CONFIG_PARAM]: JSON.stringify(doc) });
    const accepted = leaves({ tracker: parsed.tracker, web: parsed.web });
    for (const [path, value] of fields) {
      expect(accepted.has(path), `${path} is not publishable`).toBe(true);
      expect(accepted.get(path), `${path} was rejected by the overlay`).toEqual(value);
    }
  });

  it('lists every publishable field', () => {
    const missing = [...defaults().keys()].filter((path) => !fields.has(path));
    expect(missing.sort()).toEqual([...OMITTED[env]].sort());
  });

  it('differs from the compiled defaults only where pinned', () => {
    const d = defaults();
    const deviations = Object.fromEntries(
      [...fields].filter(
        ([path, value]) => !OPERATIONAL.has(path) && JSON.stringify(value) !== JSON.stringify(d.get(path)),
      ),
    );
    expect(deviations).toEqual(DEVIATIONS[env]);
  });

  it('always names a minimum extension version, never one below the first build that acts on it', () => {
    const min = fields.get('web.minExtensionVersion');
    expect(isChromeVersion(min), `web.minExtensionVersion is ${JSON.stringify(min)}`).toBe(true);
    expect(compareVersions(min as string, FIRST_UPDATE_AWARE_VERSION)).toBeGreaterThanOrEqual(0);
  });
});
