import { z } from 'zod';

import { modelFindingSchema } from './review.js';
import { reviewLanguageIdSchema } from './language.js';

const sha1Schema = z
  .string()
  .regex(/^[a-f0-9]{40}$/i)
  .transform((value) => value.toLowerCase());
const identifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .transform((value) => value.toLowerCase());

export const goldenProofExpectationSchema = z.enum([
  'verified',
  'not_verified',
]);

export const goldenProofClassificationSchema = z.enum([
  'verified',
  'not_verified',
  'incomplete',
  'invalid',
]);

const providerUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

export const goldenProofRecordSchema = z
  .object({
    id: identifierSchema,
    fixture: identifierSchema,
    language: reviewLanguageIdSchema,
    expected: goldenProofExpectationSchema,
    classification: goldenProofClassificationSchema,
    baseSha: sha1Schema,
    headSha: sha1Schema,
    proofDurationMs: z.number().int().nonnegative(),
    provider: z.enum(['groq', 'mock']).nullable(),
    model: z.string().trim().min(1).max(512).nullable(),
    promptVersion: z.string().trim().min(1).max(128).nullable(),
    usage: providerUsageSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const metadata = [record.provider, record.model, record.promptVersion];
    const populated = metadata.filter((value) => value !== null).length;
    if (populated !== 0 && populated !== metadata.length) {
      context.addIssue({
        code: 'custom',
        message: 'Provider, model, and prompt version must be recorded together.',
        path: ['provider'],
      });
    }
    if (record.provider === null && record.usage !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Provider usage requires provider metadata.',
        path: ['usage'],
      });
    }
    if (record.baseSha === record.headSha) {
      context.addIssue({
        code: 'custom',
        message: 'Golden proof revisions must differ.',
        path: ['headSha'],
      });
    }
  });

export const goldenProofRecordsSchema = z
  .array(goldenProofRecordSchema)
  .min(1)
  .max(100)
  .superRefine((records, context) => {
    const ids = new Set<string>();
    records.forEach((record, index) => {
      if (ids.has(record.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Golden proof record IDs must be unique.',
          path: [index, 'id'],
        });
      }
      ids.add(record.id);
    });
  });

export const goldenProofBaselineSchema = z
  .object({
    schemaVersion: z.literal(2),
    suiteId: identifierSchema,
    behaviorFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .transform((value) => value.toLowerCase()),
    cases: z
      .array(
        z
          .object({
            id: identifierSchema,
            language: reviewLanguageIdSchema,
            expected: goldenProofExpectationSchema,
            classification: goldenProofClassificationSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    thresholds: z
      .object({
        maxCaseRegressions: z.number().int().nonnegative().max(100),
      })
      .strict(),
  })
  .strict()
  .superRefine((baseline, context) => {
    const ids = new Set<string>();
    baseline.cases.forEach((record, index) => {
      if (ids.has(record.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Golden proof baseline case IDs must be unique.',
          path: ['cases', index, 'id'],
        });
      }
      ids.add(record.id);
    });
  });

export const goldenProofFixtureManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    cases: z
      .array(
        z
          .object({
            id: identifierSchema,
            fixture: identifierSchema,
            language: reviewLanguageIdSchema,
            expected: goldenProofExpectationSchema,
            finding: modelFindingSchema,
            reproducerSource: z.string().min(1).max(8_192),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    manifest.cases.forEach((fixture, index) => {
      if (ids.has(fixture.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Golden proof fixture IDs must be unique.',
          path: ['cases', index, 'id'],
        });
      }
      ids.add(fixture.id);
    });
  });

export type GoldenProofExpectation = z.infer<
  typeof goldenProofExpectationSchema
>;
export type GoldenProofClassification = z.infer<
  typeof goldenProofClassificationSchema
>;
export type GoldenProofRecord = z.infer<typeof goldenProofRecordSchema>;
export type GoldenProofFixtureManifest = z.infer<
  typeof goldenProofFixtureManifestSchema
>;
export type GoldenProofBaseline = z.infer<typeof goldenProofBaselineSchema>;

export function parseGoldenProofRecords(
  input: unknown,
): GoldenProofRecord[] {
  return goldenProofRecordsSchema.parse(input);
}

export function parseGoldenProofFixtureManifest(
  input: unknown,
): GoldenProofFixtureManifest {
  return goldenProofFixtureManifestSchema.parse(input);
}

export function parseGoldenProofBaseline(input: unknown): GoldenProofBaseline {
  return goldenProofBaselineSchema.parse(input);
}
