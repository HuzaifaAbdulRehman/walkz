import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export class GitFixture {
  private constructor(readonly root: string) {}

  static async create(): Promise<GitFixture> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'walkz git fixture '));
    const root = await realpath(temporaryRoot);
    const fixture = new GitFixture(root);
    fixture.git('init', '-b', 'main');
    fixture.git('config', 'user.email', 'walkz-tests@example.invalid');
    fixture.git('config', 'user.name', 'Walkz Tests');
    fixture.git('config', 'core.autocrlf', 'false');
    return fixture;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  }

  gitWithInput(input: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      input,
      windowsHide: true,
    }).trim();
  }

  async write(path: string, content: string | Buffer): Promise<void> {
    const target = join(this.root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async commitAll(message: string): Promise<string> {
    this.git('add', '--all');
    this.git('commit', '--quiet', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  async addIndexSymlink(path: string, target: string): Promise<void> {
    const blob = this.gitWithInput(target, 'hash-object', '-w', '--stdin');
    this.git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',' + path);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
