export interface ProviderCredentialStatus {
  provider: 'groq';
  connected: boolean;
}

export interface ProviderCredentialConnection extends ProviderCredentialStatus {
  connected: true;
  selectedModel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key)) &&
    Object.keys(value).length === allowed.length;
}

export function parseProviderCredentialStatus(input: unknown): ProviderCredentialStatus {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['provider', 'connected']) ||
    input.provider !== 'groq' ||
    typeof input.connected !== 'boolean'
  ) {
    throw new Error('Provider credential response was invalid.');
  }
  return { provider: 'groq', connected: input.connected };
}

export function parseProviderCredentialConnection(
  input: unknown,
): ProviderCredentialConnection {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['provider', 'connected', 'selectedModel']) ||
    input.provider !== 'groq' ||
    input.connected !== true ||
    typeof input.selectedModel !== 'string' ||
    input.selectedModel.trim().length === 0 ||
    input.selectedModel.length > 256
  ) {
    throw new Error('Provider credential response was invalid.');
  }
  return {
    provider: 'groq',
    connected: true,
    selectedModel: input.selectedModel,
  };
}

export function providerCredentialErrorMessage(input: unknown): string {
  const code = isRecord(input) && typeof input.error === 'string'
    ? input.error
    : '';
  if (code === 'provider_credential_rejected') {
    return 'Groq rejected that key. Check it or create a new one.';
  }
  if (code === 'provider_verification_unavailable') {
    return 'Groq could not verify the key right now. Try again.';
  }
  if (code === 'authentication_required') {
    return 'Your session expired. Sign in again.';
  }
  return 'Walkz could not update the key. Try again.';
}

export async function loadProviderCredentialStatus(
  apiUrl: string | undefined,
  repositoryId: string | undefined,
  cookie: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<ProviderCredentialStatus> {
  if (
    apiUrl === undefined || apiUrl.trim().length === 0 ||
    repositoryId === undefined || repositoryId.trim().length === 0
  ) {
    throw new Error('Provider credential API is unavailable.');
  }
  const response = await fetcher(
    `${apiUrl.replace(/\/$/, '')}/api/repositories/${encodeURIComponent(repositoryId)}/provider-credentials/groq`,
    { cache: 'no-store', headers: cookie === undefined ? {} : { cookie } },
  );
  if (!response.ok) {
    throw new Error(`Provider credential request failed with ${response.status}.`);
  }
  const body: unknown = await response.json();
  return parseProviderCredentialStatus(body);
}
