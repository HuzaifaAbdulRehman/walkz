'use client';

import { useState, type FormEvent } from 'react';

import {
  parseProviderCredentialConnection,
  providerCredentialErrorMessage,
} from './lib/provider-credentials';

interface ProviderCredentialFormProps {
  repositoryId: string;
  initialConnected: boolean;
  statusUnavailable?: boolean;
}

interface CredentialViewState {
  connected: boolean;
  operation: 'idle' | 'saving' | 'removing';
  confirmingRemoval: boolean;
  feedback: { error: boolean; message: string } | null;
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function ProviderCredentialForm({
  repositoryId,
  initialConnected,
  statusUnavailable = false,
}: ProviderCredentialFormProps) {
  const [apiKey, setApiKey] = useState('');
  const [view, setView] = useState<CredentialViewState>({
    connected: initialConnected,
    operation: 'idle',
    confirmingRemoval: false,
    feedback: null,
  });
  const busy = view.operation !== 'idle';
  const endpoint = `/api/repositories/${encodeURIComponent(repositoryId)}/provider-credentials/groq`;

  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || apiKey.length === 0) return;
    setView((current) => ({ ...current, operation: 'saving', feedback: null }));
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        setView((current) => ({
          ...current,
          operation: 'idle',
          feedback: { error: true, message: providerCredentialErrorMessage(body) },
        }));
        return;
      }
      const connection = parseProviderCredentialConnection(body);
      setApiKey('');
      setView({
        connected: true,
        operation: 'idle',
        confirmingRemoval: false,
        feedback: {
          error: false,
          message: `Groq connected. Walkz selected ${connection.selectedModel}.`,
        },
      });
    } catch {
      setView((current) => ({
        ...current,
        operation: 'idle',
        feedback: { error: true, message: 'Walkz could not update the key. Try again.' },
      }));
    }
  }

  async function removeCredential() {
    if (busy) return;
    setView((current) => ({ ...current, operation: 'removing', feedback: null }));
    try {
      const response = await fetch(endpoint, { method: 'DELETE' });
      if (!response.ok) {
        const body = await readResponseBody(response);
        setView((current) => ({
          ...current,
          operation: 'idle',
          feedback: {
            error: true,
            message: providerCredentialErrorMessage(body),
          },
        }));
        return;
      }
      setView({
        connected: false,
        operation: 'idle',
        confirmingRemoval: false,
        feedback: {
          error: false,
          message: 'Groq key removed. Model reviews are paused for this repository.',
        },
      });
    } catch {
      setView((current) => ({
        ...current,
        operation: 'idle',
        feedback: { error: true, message: 'Walkz could not remove the key. Try again.' },
      }));
    }
  }

  const status = statusUnavailable && !view.connected
    ? 'Status unavailable'
    : view.connected ? 'Connected' : 'Not connected';

  return (
    <section aria-labelledby="provider-connection">
      <div className="section-heading">
        <h2 id="provider-connection">Groq connection</h2>
        <span className={`badge ${view.connected ? 'status-ship' : ''}`}>{status}</span>
      </div>
      <div className="setup-card credential-card">
        <p className="setup-copy">
          {view.connected
            ? 'Groq is connected for this repository. The saved key stays encrypted and is never displayed. Enter a new key only if you want to replace it.'
            : 'Use a Groq API key for this repository. Walkz verifies it before saving an encrypted copy. The key is never shown again.'}
        </p>
        <form className="credential-form" onSubmit={saveCredential}>
          <label htmlFor="groq-api-key">Groq API key</label>
          <input
            id="groq-api-key"
            name="groq-api-key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={1_024}
            placeholder={view.connected ? 'Saved key is hidden' : undefined}
            required
            value={apiKey}
            disabled={busy}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            aria-describedby="groq-key-help"
          />
          <p id="groq-key-help" className="field-help">
            Create or manage keys in the{' '}
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
              Groq console
            </a>.
          </p>
          <div className="credential-actions">
            <button
              className="primary-action"
              type="submit"
              disabled={busy || apiKey.length === 0}
              data-busy={busy}
            >
              {view.operation === 'saving' ? 'Checking...' : view.connected ? 'Replace key' : 'Connect Groq'}
            </button>
            {view.connected && !view.confirmingRemoval ? (
              <button
                className="secondary-action"
                type="button"
                disabled={busy}
                data-busy={busy}
                onClick={() => {
                  setView((current) => ({
                    ...current,
                    confirmingRemoval: true,
                    feedback: null,
                  }));
                }}
              >
                Remove key
              </button>
            ) : null}
          </div>
          {view.connected && view.confirmingRemoval ? (
            <div className="removal-confirmation">
              <p>Model reviews will pause until you connect another key.</p>
              <div className="credential-actions">
                <button
                  className="danger-action"
                  type="button"
                  disabled={busy}
                  data-busy={busy}
                  onClick={removeCredential}
                >
                  {view.operation === 'removing' ? 'Removing...' : 'Confirm removal'}
                </button>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={busy}
                  data-busy={busy}
                  onClick={() => setView((current) => ({
                    ...current,
                    confirmingRemoval: false,
                  }))}
                >
                  Keep key
                </button>
              </div>
            </div>
          ) : null}
          {view.feedback === null ? null : (
            <p
              className={`form-message ${view.feedback.error ? 'form-error' : 'form-success'}`}
              role={view.feedback.error ? 'alert' : 'status'}
            >
              {view.feedback.message}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
