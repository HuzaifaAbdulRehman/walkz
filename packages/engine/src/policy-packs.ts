import {
  DEFAULT_POLICY_PACK_IDS,
  type PolicyPackId,
  type RepositoryConfig,
} from '@walkz/contracts';

const POLICY_RISK_REASONS: Record<PolicyPackId, readonly string[]> = {
  'security-core@1': ['security-sensitive path'],
  'supply-chain@1': ['dependency or package metadata'],
  'delivery-safety@1': [
    'delivery or data migration path',
    'configuration or executable change',
  ],
};

export interface ResolvedPolicyPacks {
  ids: PolicyPackId[];
  securityRiskReasons: ReadonlySet<string>;
}

export function resolvePolicyPacks(
  config: Pick<RepositoryConfig, 'policyPacks'>,
): ResolvedPolicyPacks {
  const ids = config.policyPacks === undefined
    ? [...DEFAULT_POLICY_PACK_IDS]
    : [...config.policyPacks];
  const securityRiskReasons = new Set<string>();

  for (const id of ids) {
    for (const reason of POLICY_RISK_REASONS[id]) {
      securityRiskReasons.add(reason);
    }
  }

  return { ids, securityRiskReasons };
}
