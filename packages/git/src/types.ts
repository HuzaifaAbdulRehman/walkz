export type GitComparisonMode = 'branch' | 'staged';

export interface ResolvedGitReferences {
  mode: GitComparisonMode;
  baseRef: string;
  baseTipSha: string;
  baseSha: string;
  headRef: 'HEAD' | 'INDEX';
  headSha: string | null;
  guidanceSha: string;
}

export type ChangedFileStatus =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'type_changed'
  | 'unmerged'
  | 'unknown';

export type ChangedFileKind =
  | 'text'
  | 'binary'
  | 'symlink'
  | 'submodule';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
  statusCode: string;
  similarity?: number;
  oldMode: string;
  newMode: string;
  additions: number | null;
  deletions: number | null;
  kind: ChangedFileKind;
}

export type CoverageOmissionReason =
  | 'binary'
  | 'diff_budget'
  | 'excluded'
  | 'file_budget'
  | 'guidance_budget'
  | 'guidance_invalid'
  | 'submodule'
  | 'symlink';

export interface CoverageOmission {
  path: string;
  reason: CoverageOmissionReason;
}

export interface UnifiedDiffCollection {
  text: string;
  bytes: number;
  includedPaths: string[];
  omissions: CoverageOmission[];
}

export type DiffLineIndex = ReadonlyMap<string, ReadonlySet<number>>;

export interface RepositoryGuidanceDocument {
  path: string;
  content: string;
  bytes: number;
  sourceSha: string;
}

export interface RepositoryGuidance {
  documents: RepositoryGuidanceDocument[];
  bytes: number;
  omissions: RepositoryGuidanceOmission[];
}

export interface RepositoryGuidanceOmission {
  path: string;
  reason: 'budget' | 'invalid_encoding' | 'unsafe_type';
}

export interface ChangeRisk {
  score: number;
  reasons: string[];
}

export interface ReviewContextCoverage {
  complete: boolean;
  changedFileCount: number;
  selectedFileCount: number;
  diffBytes: number;
  omissions: CoverageOmission[];
}

export interface ReviewContext {
  references: ResolvedGitReferences;
  changedFiles: ChangedFile[];
  risks: Record<string, ChangeRisk>;
  diff: string;
  lineIndex: DiffLineIndex;
  guidance: RepositoryGuidance;
  coverage: ReviewContextCoverage;
}
