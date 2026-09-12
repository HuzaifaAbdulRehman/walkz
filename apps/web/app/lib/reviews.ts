export interface DashboardReview {
  id: string;
  pullRequestId: string | null;
  baseSha: string;
  headSha: string;
  status: string;
  verdict: 'SHIP' | 'FIX' | 'HUMAN' | 'INCONCLUSIVE' | 'ERROR' | null;
  resultSummary: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DashboardRepository {
  id: string;
  owner: string;
  name: string;
  selectedRepositoryId: string | null;
}

export interface DashboardInstallation {
  id: string;
  repositories: DashboardRepository[];
}

export interface DashboardConfiguration {
  id: string;
  schemaVersion: number;
  configHash: string;
  createdAt: string;
  provider: {
    name: 'groq';
    model: string;
  };
  budget: {
    diffBytes: number;
    files: number;
    tokens: number;
    commandTimeoutMs: number;
    commandOutputBytesPerStream: number;
  };
  triggerPolicy: 'manual' | 'ready_for_review' | 'every_push';
  blockingEvidenceLevels: Array<'VERIFIED' | 'SUPPORTED'>;
  commandApprovalPolicy: 'prompt' | 'trusted_config';
  commandCount: number;
  requiredCommandCount: number;
  premiumEnabled: false;
  spendingLimitUsd: 0;
}

export interface DashboardFinding {
  id: string;
  fingerprint: string;
  category: 'correctness' | 'security' | 'performance' | 'reliability' |
    'maintainability' | null;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  lifecycleStatus: 'proposed' | 'challenged' | 'proving' | 'verified' |
    'supported' | 'unverified' | 'dismissed' | 'fixed';
  evidenceLevel: 'VERIFIED' | 'SUPPORTED' | 'UNVERIFIED';
  advisoryConfidence: number | null;
  summary: string;
  claim: string | null;
  failureMechanism: string | null;
  suggestedProof: string | null;
  createdAt: string;
}

const verdicts = new Set<NonNullable<DashboardReview['verdict']>>([
  'SHIP', 'FIX', 'HUMAN', 'INCONCLUSIVE', 'ERROR',
]);
const triggerPolicies = new Set<DashboardConfiguration['triggerPolicy']>([
  'manual', 'ready_for_review', 'every_push',
]);
const blockingEvidenceLevels = new Set<DashboardConfiguration['blockingEvidenceLevels'][number]>([
  'VERIFIED', 'SUPPORTED',
]);
const commandApprovalPolicies = new Set<DashboardConfiguration['commandApprovalPolicy']>([
  'prompt', 'trusted_config',
]);
const findingCategories = new Set<NonNullable<DashboardFinding['category']>>([
  'correctness', 'security', 'performance', 'reliability', 'maintainability',
]);
const findingSeverities = new Set<NonNullable<DashboardFinding['severity']>>([
  'low', 'medium', 'high', 'critical',
]);
const findingLifecycles = new Set<DashboardFinding['lifecycleStatus']>([
  'proposed', 'challenged', 'proving', 'verified', 'supported', 'unverified',
  'dismissed', 'fixed',
]);
const findingEvidenceLevels = new Set<DashboardFinding['evidenceLevel']>([
  'VERIFIED', 'SUPPORTED', 'UNVERIFIED',
]);
const githubIdPattern = /^[1-9][0-9]{0,18}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDashboardInstallations(input: unknown): DashboardInstallation[] {
  if (typeof input !== 'object' || input === null || !('installations' in input)) {
    throw new Error('Installation response was invalid.');
  }
  const installations = (input as { installations: unknown }).installations;
  if (!Array.isArray(installations) || installations.length > 100) {
    throw new Error('Installation response was invalid.');
  }
  return installations.map((installation) => {
    if (typeof installation !== 'object' || installation === null) {
      throw new Error('Installation response was invalid.');
    }
    const value = installation as Record<string, unknown>;
    if (
      typeof value.id !== 'string' || !githubIdPattern.test(value.id) ||
      !Array.isArray(value.repositories) || value.repositories.length > 1_000
    ) {
      throw new Error('Installation response was invalid.');
    }
    const repositories = value.repositories.map((repository): DashboardRepository => {
      if (typeof repository !== 'object' || repository === null) {
        throw new Error('Installation response was invalid.');
      }
      const item = repository as Record<string, unknown>;
      if (
        typeof item.id !== 'string' || !githubIdPattern.test(item.id) ||
        typeof item.owner !== 'string' || item.owner.trim().length === 0 || item.owner.length > 100 ||
        typeof item.name !== 'string' || item.name.trim().length === 0 || item.name.length > 100 ||
        (item.selectedRepositoryId !== null && (
          typeof item.selectedRepositoryId !== 'string' || !uuidPattern.test(item.selectedRepositoryId)
        ))
      ) {
        throw new Error('Installation response was invalid.');
      }
      return {
        id: item.id,
        owner: item.owner,
        name: item.name,
        selectedRepositoryId: item.selectedRepositoryId,
      };
    });
    return { id: value.id, repositories };
  });
}

export async function loadDashboardInstallations(
  apiUrl: string | undefined,
  cookie: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DashboardInstallation[] | null> {
  if (
    apiUrl === undefined || apiUrl.trim().length === 0 ||
    cookie === undefined || cookie.trim().length === 0
  ) return [];
  const response = await fetcher(`${apiUrl.replace(/\/$/, '')}/api/installations`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Installation request failed with ${response.status}.`);
  const body: unknown = await response.json();
  return parseDashboardInstallations(body);
}

function isDashboardVerdict(value: string): value is NonNullable<DashboardReview['verdict']> {
  return verdicts.has(value as NonNullable<DashboardReview['verdict']>);
}

function parseDashboardReview(input: unknown): DashboardReview | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value.id !== 'string' ||
    (typeof value.pullRequestId !== 'string' && value.pullRequestId !== null) ||
    typeof value.baseSha !== 'string' || typeof value.headSha !== 'string' ||
    typeof value.status !== 'string' ||
    (typeof value.verdict !== 'string' && value.verdict !== null) ||
    (typeof value.resultSummary !== 'string' && value.resultSummary !== null) ||
    typeof value.createdAt !== 'string' ||
    (typeof value.completedAt !== 'string' && value.completedAt !== null)
  ) return null;
  if (value.status.trim().length === 0 || (value.verdict !== null && !isDashboardVerdict(value.verdict))) {
    return null;
  }
  return {
    id: value.id,
    pullRequestId: value.pullRequestId,
    baseSha: value.baseSha,
    headSha: value.headSha,
    status: value.status,
    verdict: value.verdict === null ? null : value.verdict as NonNullable<DashboardReview['verdict']>,
    resultSummary: value.resultSummary,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
  };
}

export function parseDashboardReviewHistory(input: unknown): DashboardReview[] {
  if (typeof input !== 'object' || input === null || !('reviews' in input)) {
    throw new Error('Review history response was invalid.');
  }
  const reviews = (input as { reviews: unknown }).reviews;
  if (!Array.isArray(reviews)) throw new Error('Review history response was invalid.');
  const parsed: DashboardReview[] = [];
  for (const review of reviews) {
    const mapped = parseDashboardReview(review);
    if (mapped === null) throw new Error('Review history response was invalid.');
    parsed.push(mapped);
  }
  return parsed;
}

function parseDashboardFinding(input: unknown): DashboardFinding | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value.id !== 'string' || !uuidPattern.test(value.id) ||
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.fingerprint) ||
    (value.category !== null && (
      typeof value.category !== 'string' ||
      !findingCategories.has(value.category as NonNullable<DashboardFinding['category']>)
    )) ||
    (value.severity !== null && (
      typeof value.severity !== 'string' ||
      !findingSeverities.has(value.severity as NonNullable<DashboardFinding['severity']>)
    )) ||
    (typeof value.path !== 'string' && value.path !== null) ||
    (typeof value.startLine !== 'number' && value.startLine !== null) ||
    (typeof value.endLine !== 'number' && value.endLine !== null) ||
    typeof value.lifecycleStatus !== 'string' ||
    !findingLifecycles.has(value.lifecycleStatus as DashboardFinding['lifecycleStatus']) ||
    typeof value.evidenceLevel !== 'string' ||
    !findingEvidenceLevels.has(value.evidenceLevel as DashboardFinding['evidenceLevel']) ||
    (typeof value.advisoryConfidence !== 'number' && value.advisoryConfidence !== null) ||
    typeof value.summary !== 'string' ||
    (typeof value.claim !== 'string' && value.claim !== null) ||
    (typeof value.failureMechanism !== 'string' && value.failureMechanism !== null) ||
    (typeof value.suggestedProof !== 'string' && value.suggestedProof !== null) ||
    typeof value.createdAt !== 'string'
  ) return null;
  if (
    (value.startLine !== null && (!Number.isInteger(value.startLine) || value.startLine < 1)) ||
    (value.endLine !== null && (!Number.isInteger(value.endLine) || value.endLine < 1)) ||
    (value.startLine !== null && value.endLine !== null && value.endLine < value.startLine) ||
    (value.advisoryConfidence !== null && (
      value.advisoryConfidence < 0 || value.advisoryConfidence > 1
    ))
  ) return null;
  return value as unknown as DashboardFinding;
}

export function parseDashboardFindings(input: unknown): DashboardFinding[] {
  if (typeof input !== 'object' || input === null || !('findings' in input)) {
    throw new Error('Review findings response was invalid.');
  }
  const findings = (input as { findings: unknown }).findings;
  if (!Array.isArray(findings)) {
    throw new Error('Review findings response was invalid.');
  }
  return findings.map((finding) => {
    const parsed = parseDashboardFinding(finding);
    if (parsed === null) throw new Error('Review findings response was invalid.');
    return parsed;
  });
}

export function parseDashboardConfigurationHistory(input: unknown): DashboardConfiguration[] {
  if (typeof input !== 'object' || input === null || !('configurations' in input)) {
    throw new Error('Configuration history response was invalid.');
  }
  const configurations = (input as { configurations: unknown }).configurations;
  if (!Array.isArray(configurations)) throw new Error('Configuration history response was invalid.');
  return configurations.map((configuration) => {
    if (typeof configuration !== 'object' || configuration === null) {
      throw new Error('Configuration history response was invalid.');
    }
    const value = configuration as Record<string, unknown>;
    const provider = value.provider;
    const budget = value.budget;
    const evidence = value.blockingEvidenceLevels;
    const providerValue = provider as Record<string, unknown>;
    const budgetValue = budget as Record<string, unknown>;
    const commandCount = value.commandCount;
    const requiredCommandCount = value.requiredCommandCount;
    if (
      typeof value.id !== 'string' ||
      typeof value.schemaVersion !== 'number' ||
      !Number.isInteger(value.schemaVersion) ||
      typeof value.configHash !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof provider !== 'object' || provider === null ||
      providerValue.name !== 'groq' ||
      typeof providerValue.model !== 'string' ||
      typeof budget !== 'object' || budget === null ||
      typeof budgetValue.diffBytes !== 'number' || !Number.isInteger(budgetValue.diffBytes) ||
      budgetValue.diffBytes < 1 ||
      typeof budgetValue.files !== 'number' || !Number.isInteger(budgetValue.files) ||
      budgetValue.files < 1 ||
      typeof budgetValue.tokens !== 'number' || !Number.isInteger(budgetValue.tokens) ||
      budgetValue.tokens < 1 ||
      typeof budgetValue.commandTimeoutMs !== 'number' || !Number.isInteger(budgetValue.commandTimeoutMs) ||
      budgetValue.commandTimeoutMs < 1 ||
      typeof budgetValue.commandOutputBytesPerStream !== 'number' || !Number.isInteger(budgetValue.commandOutputBytesPerStream) ||
      budgetValue.commandOutputBytesPerStream < 1 ||
      typeof value.triggerPolicy !== 'string' || !triggerPolicies.has(value.triggerPolicy as DashboardConfiguration['triggerPolicy']) ||
      !Array.isArray(evidence) || evidence.length === 0 ||
      !evidence.every((item) => typeof item === 'string' && blockingEvidenceLevels.has(item as DashboardConfiguration['blockingEvidenceLevels'][number])) ||
      typeof value.commandApprovalPolicy !== 'string' || !commandApprovalPolicies.has(value.commandApprovalPolicy as DashboardConfiguration['commandApprovalPolicy']) ||
      typeof commandCount !== 'number' || !Number.isInteger(commandCount) || commandCount < 0 ||
      typeof requiredCommandCount !== 'number' || !Number.isInteger(requiredCommandCount) || requiredCommandCount < 0 || requiredCommandCount > commandCount ||
      value.premiumEnabled !== false || value.spendingLimitUsd !== 0
    ) {
      throw new Error('Configuration history response was invalid.');
    }
    return {
      id: value.id,
      schemaVersion: value.schemaVersion,
      configHash: value.configHash,
      createdAt: value.createdAt,
      provider: {
        name: 'groq',
        model: providerValue.model,
      },
      budget: {
        diffBytes: budgetValue.diffBytes,
        files: budgetValue.files,
        tokens: budgetValue.tokens,
        commandTimeoutMs: budgetValue.commandTimeoutMs,
        commandOutputBytesPerStream: budgetValue.commandOutputBytesPerStream,
      },
      triggerPolicy: value.triggerPolicy as DashboardConfiguration['triggerPolicy'],
      blockingEvidenceLevels: evidence as DashboardConfiguration['blockingEvidenceLevels'],
      commandApprovalPolicy: value.commandApprovalPolicy as DashboardConfiguration['commandApprovalPolicy'],
      commandCount,
      requiredCommandCount,
      premiumEnabled: false,
      spendingLimitUsd: 0,
    };
  });
}

export async function loadDashboardReviews(
  apiUrl: string | undefined,
  repositoryId: string | undefined,
  cookie: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DashboardReview[]> {
  if (apiUrl === undefined || apiUrl.trim().length === 0 || repositoryId === undefined || repositoryId.trim().length === 0) {
    return [];
  }
  const response = await fetcher(
    `${apiUrl.replace(/\/$/, '')}/api/repositories/${encodeURIComponent(repositoryId)}/reviews`,
    { cache: 'no-store', headers: cookie === undefined ? {} : { cookie } },
  );
  if (!response.ok) throw new Error(`Review history request failed with ${response.status}.`);
  const body: unknown = await response.json();
  return parseDashboardReviewHistory(body);
}

export async function loadDashboardFindings(
  apiUrl: string | undefined,
  repositoryId: string | undefined,
  reviewRunId: string,
  cookie: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DashboardFinding[]> {
  if (
    apiUrl === undefined ||
    apiUrl.trim().length === 0 ||
    repositoryId === undefined ||
    repositoryId.trim().length === 0
  ) return [];
  const response = await fetcher(
    `${apiUrl.replace(/\/$/, '')}/api/repositories/${encodeURIComponent(repositoryId)}/reviews/${encodeURIComponent(reviewRunId)}/findings`,
    { cache: 'no-store', headers: cookie === undefined ? {} : { cookie } },
  );
  if (!response.ok) {
    throw new Error(`Review findings request failed with ${response.status}.`);
  }
  const body: unknown = await response.json();
  return parseDashboardFindings(body);
}

export async function loadDashboardConfigurations(
  apiUrl: string | undefined,
  repositoryId: string | undefined,
  cookie: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DashboardConfiguration[]> {
  if (apiUrl === undefined || apiUrl.trim().length === 0 || repositoryId === undefined || repositoryId.trim().length === 0) {
    return [];
  }
  const response = await fetcher(
    `${apiUrl.replace(/\/$/, '')}/api/repositories/${encodeURIComponent(repositoryId)}/configs`,
    { cache: 'no-store', headers: cookie === undefined ? {} : { cookie } },
  );
  if (!response.ok) throw new Error(`Configuration history request failed with ${response.status}.`);
  const body: unknown = await response.json();
  return parseDashboardConfigurationHistory(body);
}
