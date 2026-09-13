import { createHash } from 'node:crypto';

import {
  createDefaultWalkzConfig,
  parseWalkzConfig,
} from '@walkz/contracts';
import { describe, expect, it } from 'vitest';

import {
  hashWalkzConfig,
  resolvePolicyPacks,
} from '../src/index.js';

describe('policy packs', () => {
  it('resolves the versioned security pack for legacy configurations', () => {
    const current = createDefaultWalkzConfig();
    const { policyPacks: _policyPacks, ...legacy } = current;

    const resolved = resolvePolicyPacks(parseWalkzConfig(legacy));

    expect(resolved.ids).toEqual([
      'security-core@1',
      'supply-chain@1',
      'delivery-safety@1',
    ]);
    expect(resolved.securityRiskReasons).toEqual(new Set([
      'security-sensitive path',
      'dependency or package metadata',
      'delivery or data migration path',
      'configuration or executable change',
    ]));
    expect(hashWalkzConfig(legacy)).toBe(
      createHash('sha256')
        .update(JSON.stringify(legacy), 'utf8')
        .digest('hex'),
    );
  });

  it('honours an explicit empty selection without adding hidden policy', () => {
    const resolved = resolvePolicyPacks({ policyPacks: [] });

    expect(resolved.ids).toEqual([]);
    expect(resolved.securityRiskReasons.size).toBe(0);
  });

  it('activates only the reasons owned by a selected pack', () => {
    const resolved = resolvePolicyPacks({
      policyPacks: ['supply-chain@1'],
    });

    expect(resolved.securityRiskReasons).toEqual(new Set([
      'dependency or package metadata',
    ]));
  });

  it('binds the selected pack ids into the configuration hash', () => {
    const enabled = createDefaultWalkzConfig();
    const disabled = { ...enabled, policyPacks: [] };

    expect(hashWalkzConfig(enabled)).not.toBe(hashWalkzConfig(disabled));
  });
});
