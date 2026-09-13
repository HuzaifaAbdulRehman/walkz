import type {
  ProofCommand,
  ReviewLanguageId,
} from '@walkz/contracts';

export interface ReviewLanguageAdapter {
  id: ReviewLanguageId;
  displayName: string;
  fileExtensions: readonly string[];
  reviewGuidance: string;
  proofRuntime: {
    defaultContainerImage: string;
    command: ProofCommand;
    reproducerPath: string;
  };
}

const adapters: readonly ReviewLanguageAdapter[] = [
  {
    id: 'javascript-typescript',
    displayName: 'JavaScript and TypeScript',
    fileExtensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
    reviewGuidance:
      'Check async control flow, runtime type boundaries, module semantics, and resource cleanup.',
    proofRuntime: {
      defaultContainerImage:
        'node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf',
      command: {
        executable: 'node',
        args: ['.walkz-proof/reproducer.mjs'],
        cwd: '.',
      },
      reproducerPath: '.walkz-proof/reproducer.mjs',
    },
  },
  {
    id: 'python',
    displayName: 'Python',
    fileExtensions: ['.py', '.pyi'],
    reviewGuidance:
      'Check exception paths, mutable state, iterator and async behavior, runtime type mismatches, and context-manager cleanup.',
    proofRuntime: {
      defaultContainerImage:
        'python@sha256:9ab8d9c8514b44f90cf0029dd42fdd7e9e211e639c8b995304cc04568dee900f',
      command: {
        executable: 'python',
        args: [
          '-B',
          '-c',
          "import runpy; runpy.run_path('.walkz-proof/reproducer.py', run_name='__main__')",
        ],
        cwd: '.',
      },
      reproducerPath: '.walkz-proof/reproducer.py',
    },
  },
];

const adaptersById = new Map(adapters.map((adapter) => [adapter.id, adapter]));

function extension(path: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? '' : fileName.slice(dot);
}

export function listReviewLanguageAdapters(): readonly ReviewLanguageAdapter[] {
  return adapters;
}

export function getReviewLanguageAdapter(
  id: ReviewLanguageId,
): ReviewLanguageAdapter {
  const adapter = adaptersById.get(id);
  if (adapter === undefined) {
    throw new Error(`Review language adapter is unavailable: ${id}`);
  }
  return adapter;
}

export function resolveReviewLanguageAdapters(
  paths: readonly string[],
): ReviewLanguageAdapter[] {
  const extensions = new Set(paths.map(extension));
  return adapters.filter((adapter) =>
    adapter.fileExtensions.some((candidate) => extensions.has(candidate)),
  );
}
