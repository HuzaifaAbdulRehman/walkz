import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const projectRoot = dirname(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
);
const image = process.env.WALKZ_DOCKER_TEST_IMAGE;
const dockerTest = image === undefined ? it.skip : it;

dockerTest(
  'runs the clean and broken golden fixtures through the proof demo',
  async () => {
    const result = await executeFile(
      process.execPath,
      [join(projectRoot, 'scripts', 'evaluate-golden.mjs'), '--json'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          WALKZ_DOCKER_TEST_IMAGE: image,
        },
      },
    );
    const report = JSON.parse(result.stdout) as {
      behavior: {
        codeRevision: string;
        languageAdapters: Array<{
          id: string;
          containerImage: string;
          command: { executable: string };
        }>;
        provider: null;
      };
      behaviorFingerprint: string;
      records: Array<{ id: string; classification: string }>;
      metrics: Record<string, number>;
      languages: Array<{
        language: string;
        metrics: Record<string, number>;
      }>;
      comparison: {
        baselineFingerprint: string;
        caseRegressions: unknown[];
        threshold: number;
        passed: boolean;
      };
    };

    expect(report.behavior).toMatchObject({
      codeRevision: expect.stringMatching(/^[a-f0-9]{40}$/),
      languageAdapters: [
        {
          id: 'javascript-typescript',
          containerImage: image,
          command: { executable: 'node' },
        },
        {
          id: 'python',
          containerImage: expect.stringMatching(/^python@sha256:[a-f0-9]{64}$/),
          command: { executable: 'python' },
        },
      ],
      provider: null,
    });
    expect(report.behaviorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(report.records).toEqual([
      expect.objectContaining({
        id: 'broken-boundary',
        classification: 'verified',
      }),
      expect.objectContaining({
        id: 'clean-positive-value',
        classification: 'not_verified',
      }),
      expect.objectContaining({
        id: 'python-broken-boundary',
        language: 'python',
        classification: 'verified',
      }),
      expect.objectContaining({
        id: 'python-clean-positive-value',
        language: 'python',
        classification: 'not_verified',
      }),
    ]);
    expect(report.metrics).toMatchObject({
      caseCount: 4,
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      proofRate: 0.5,
      modelInvocationCount: 0,
    });
    expect(report.languages).toEqual([
      expect.objectContaining({
        language: 'javascript-typescript',
        metrics: expect.objectContaining({
          caseCount: 2,
          truePositives: 1,
          falsePositives: 0,
        }),
      }),
      expect.objectContaining({
        language: 'python',
        metrics: expect.objectContaining({
          caseCount: 2,
          truePositives: 1,
          falsePositives: 0,
        }),
      }),
    ]);
    expect(report.comparison).toEqual({
      baselineFingerprint:
        '40642cc0f8213970f56a0f1e089a2bbf93c2828d5f11146424ab55b4707b5e48',
      caseRegressions: [],
      threshold: 0,
      passed: true,
    });
  },
  60_000,
);
