import { z } from 'zod';

const noNulString = z.string().refine((value) => !value.includes('\0'), {
  message: 'Must not contain NUL bytes.',
});
const nonEmptyString = noNulString.trim().min(1);

export const evidenceLevelSchema = z.enum([
  'VERIFIED',
  'SUPPORTED',
  'UNVERIFIED',
]);

export const policyPackIdSchema = z.enum([
  'security-core@1',
  'supply-chain@1',
  'delivery-safety@1',
]);

export const DEFAULT_POLICY_PACK_IDS = [
  'security-core@1',
  'supply-chain@1',
  'delivery-safety@1',
] as const;

export const approvedCommandSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    executable: nonEmptyString,
    args: z.array(noNulString).max(64),
    cwd: nonEmptyString.default('.'),
    required: z.boolean().default(true),
  })
  .strict();

export const repositoryConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseBranch: nonEmptyString.nullable(),
    paths: z
      .object({
        include: z.array(nonEmptyString).min(1).max(64),
        exclude: z.array(nonEmptyString).max(64),
      })
      .strict(),
    commands: z.array(approvedCommandSchema).max(8),
    commandTimeoutMs: z.number().int().min(100).max(30 * 60 * 1_000),
    commandOutputBytesPerStream: z
      .number()
      .int()
      .min(1_024)
      .max(10 * 1_024 * 1_024),
    diffBudgetBytes: z.number().int().min(1_024).max(10 * 1_024 * 1_024),
    fileBudget: z.number().int().min(1).max(1_000),
    tokenBudget: z.number().int().min(1_000).max(1_000_000),
    provider: z
      .object({
        name: z.literal('groq'),
        model: nonEmptyString,
      })
      .strict(),
    triggerPolicy: z.enum(['manual', 'ready_for_review', 'every_push']),
    blockingEvidenceLevels: z
      .array(z.enum(['VERIFIED', 'SUPPORTED']))
      .min(1)
      .max(2),
    policyPacks: z.array(policyPackIdSchema).max(8).optional(),
    commandApprovalPolicy: z.enum(['prompt', 'trusted_config']),
    premiumEnabled: z.literal(false),
    spendingLimitUsd: z.literal(0),
  })
  .strict()
  .superRefine((config, context) => {
    const commandIds = new Set<string>();
    config.commands.forEach((command, index) => {
      if (commandIds.has(command.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Command ids must be unique.',
          path: ['commands', index, 'id'],
        });
      }
      commandIds.add(command.id);
    });

    if (
      new Set(config.blockingEvidenceLevels).size !==
      config.blockingEvidenceLevels.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Blocking evidence levels must be unique.',
        path: ['blockingEvidenceLevels'],
      });
    }

    if (
      config.policyPacks !== undefined &&
      new Set(config.policyPacks).size !== config.policyPacks.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Policy pack ids must be unique.',
        path: ['policyPacks'],
      });
    }
  });

export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;
export type PolicyPackId = z.infer<typeof policyPackIdSchema>;
export type ApprovedCommand = z.infer<typeof approvedCommandSchema>;
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

export interface WalkzCliOverrides {
  baseBranch?: string | null;
  model?: string;
  commandApprovalPolicy?: RepositoryConfig['commandApprovalPolicy'];
}

export function createDefaultWalkzConfig(
  commands: readonly ApprovedCommand[] = [],
): RepositoryConfig {
  return parseWalkzConfig({
    schemaVersion: 1,
    baseBranch: null,
    paths: {
      include: ['**/*'],
      exclude: [
        '.git/**',
        'coverage/**',
        'dist/**',
        'node_modules/**',
      ],
    },
    commands,
    commandTimeoutMs: 120_000,
    commandOutputBytesPerStream: 262_144,
    diffBudgetBytes: 524_288,
    fileBudget: 100,
    tokenBudget: 16_000,
    provider: {
      name: 'groq',
      model: 'auto',
    },
    triggerPolicy: 'manual',
    blockingEvidenceLevels: ['VERIFIED'],
    policyPacks: [...DEFAULT_POLICY_PACK_IDS],
    commandApprovalPolicy: 'prompt',
    premiumEnabled: false,
    spendingLimitUsd: 0,
  });
}

export function parseWalkzConfig(input: unknown): RepositoryConfig {
  return repositoryConfigSchema.parse(input);
}

export function mergeCliOverrides(
  config: RepositoryConfig,
  overrides: WalkzCliOverrides,
): RepositoryConfig {
  return parseWalkzConfig({
    ...config,
    ...(overrides.baseBranch !== undefined && {
      baseBranch: overrides.baseBranch,
    }),
    ...(overrides.commandApprovalPolicy !== undefined && {
      commandApprovalPolicy: overrides.commandApprovalPolicy,
    }),
    provider: {
      ...config.provider,
      ...(overrides.model !== undefined && {
        model: overrides.model,
      }),
    },
  });
}
