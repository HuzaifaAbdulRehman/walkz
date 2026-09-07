import type { ProofPlan } from '@walkz/contracts';
import {
  withProofWorkspaces,
  type ProofWorkspaceLimits,
} from '@walkz/git';
import {
  executeProofPair,
  type ExecuteDockerProofOptions,
  type ProofExecutionPair,
} from '@walkz/sandbox';

import {
  fingerprintProofPlan,
  verifyProofPlan,
  type ProofBudget,
  type ProofPlanAuthorization,
} from './proof-plan.js';

export interface RunProofPlanInContainersOptions {
  repositoryRoot: string;
  authorization: ProofPlanAuthorization;
  budget: ProofBudget;
  workspaceLimits: ProofWorkspaceLimits;
  temporaryRoot?: string;
  signal?: AbortSignal;
  docker?: Omit<ExecuteDockerProofOptions, 'signal'>;
}

export async function runProofPlanInContainers(
  planInput: unknown,
  options: RunProofPlanInContainersOptions,
): Promise<ProofExecutionPair> {
  const plan: ProofPlan = verifyProofPlan(
    planInput,
    options.authorization,
    options.budget,
  );
  const planDigest = fingerprintProofPlan(plan);

  return withProofWorkspaces(
    {
      repositoryRoot: options.repositoryRoot,
      baseSha: plan.baseSha,
      headSha: plan.headSha,
      limits: options.workspaceLimits,
      ...(options.temporaryRoot !== undefined && {
        temporaryRoot: options.temporaryRoot,
      }),
      ...(options.signal !== undefined && { signal: options.signal }),
    },
    async (workspaces) =>
      executeProofPair(
        plan,
        planDigest,
        {
          base: workspaces.base,
          head: workspaces.head,
        },
        {
          ...options.docker,
          ...(options.signal !== undefined && { signal: options.signal }),
        },
      ),
  );
}
