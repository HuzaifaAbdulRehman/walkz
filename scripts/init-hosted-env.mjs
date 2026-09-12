import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

function replaceSetting(template, name, value) {
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (!pattern.test(template)) {
    throw new Error(`Missing ${name} in the hosted environment template.`);
  }
  return template.replace(pattern, `${name}=${value}`);
}

export function parsePublicUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new Error('A public HTTPS URL is required.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The public URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('Use a public HTTPS origin without a path, query, or credentials.');
  }
  return url.origin;
}

export function buildHostedEnvironment(template, publicUrl, randomSource = randomBytes) {
  const origin = parsePublicUrl(publicUrl);
  const base64UrlSecret = () => randomSource(32).toString('base64url');
  let output = template;
  output = replaceSetting(output, 'POSTGRES_PASSWORD', base64UrlSecret());
  output = replaceSetting(
    output,
    'GITHUB_OAUTH_CALLBACK_URL',
    `${origin}/auth/github/callback`,
  );
  output = replaceSetting(output, 'WALKZ_PUBLIC_URL', origin);
  output = replaceSetting(output, 'GITHUB_WEBHOOK_SECRET', base64UrlSecret());
  output = replaceSetting(output, 'WALKZ_OAUTH_STATE_SECRET', base64UrlSecret());
  output = replaceSetting(
    output,
    'WALKZ_CREDENTIAL_KEYS_JSON',
    JSON.stringify({ 'local-2026': randomSource(32).toString('base64') }),
  );
  return output;
}

export async function writeHostedEnvironment(options) {
  const template = await readFile(options.templatePath, 'utf8');
  const output = buildHostedEnvironment(template, options.publicUrl, options.randomSource);
  await writeFile(options.outputPath, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function main() {
  let values;
  try {
    values = parseArgs({
      options: { 'public-url': { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`);
    process.exitCode = 2;
    return;
  }
  if (values['public-url'] === undefined) {
    process.stderr.write(
      'Usage: npm run hosted:init -- --public-url https://your-public-origin\n',
    );
    process.exitCode = 2;
    return;
  }
  try {
    await writeHostedEnvironment({
      templatePath: resolve(repositoryRoot, 'infra', '.env.example'),
      outputPath: resolve(repositoryRoot, 'infra', '.env'),
      publicUrl: values['public-url'],
    });
    process.stdout.write(
      'Created infra/.env. Open it locally to copy GITHUB_WEBHOOK_SECRET into GitHub.\n',
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      process.stderr.write(
        'infra/.env already exists. Move or delete it before running this command again.\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : 'Setup failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
