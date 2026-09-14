import { describe, expect, it } from 'vitest';

import {
  renderProductionCompose,
  validateImmutableImageReference,
  verifyProductionComposeModel,
} from './production-compose.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const images = {
  api: digest,
  web: `registry.example/walkz-web@${digest}`,
  worker: `registry.example/walkz-worker@${digest}`,
};

function hardenedService(image, networks) {
  return {
    image,
    init: true,
    networks: Object.fromEntries(networks.map((network) => [network, null])),
    read_only: true,
    user: '1000:1000',
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
  };
}

function productionModel() {
  const databaseUrl = 'postgresql://walkz:a-safe-password@postgres:5432/walkz';
  const apiEnvironment = {
    DATABASE_URL: databaseUrl,
    GITHUB_APP_ID: '12345',
    GITHUB_PRIVATE_KEY_BASE64: Buffer.from(
      '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
    ).toString('base64'),
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    GITHUB_OAUTH_CALLBACK_URL: 'https://walkz.dev/auth/github/callback',
    GITHUB_WEBHOOK_SECRET: 'w'.repeat(32),
    WALKZ_CREDENTIAL_ACTIVE_KEY_ID: 'production-2026',
    WALKZ_CREDENTIAL_KEYS_JSON: JSON.stringify({
      'production-2026': Buffer.alloc(32, 1).toString('base64'),
    }),
    WALKZ_OAUTH_STATE_SECRET: 's'.repeat(32),
  };
  return {
    networks: {
      data: { internal: true },
      edge: {},
      egress: {},
    },
    services: {
      postgres: {
        image: `postgres@${digest}`,
        environment: { POSTGRES_PASSWORD: 'a-safe-password' },
        networks: { data: null },
        volumes: [{ type: 'volume', source: 'walkz-postgres-data', target: '/var/lib/postgresql/data' }],
      },
      redis: {
        image: `redis@${digest}`,
        networks: { data: null },
      },
      migrate: {
        ...hardenedService(images.api, ['data']),
        environment: { DATABASE_URL: databaseUrl },
      },
      api: {
        ...hardenedService(images.api, ['data', 'edge', 'egress']),
        environment: apiEnvironment,
      },
      worker: {
        ...hardenedService(images.worker, ['data', 'egress']),
        expose: ['3002'],
        healthcheck: {
          test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3002/health/ready')"],
        },
        environment: {
          DATABASE_URL: databaseUrl,
          GITHUB_APP_ID: apiEnvironment.GITHUB_APP_ID,
          GITHUB_PRIVATE_KEY_BASE64: apiEnvironment.GITHUB_PRIVATE_KEY_BASE64,
          REDIS_URL: 'redis://redis:6379/0',
          WALKZ_CREDENTIAL_ACTIVE_KEY_ID: apiEnvironment.WALKZ_CREDENTIAL_ACTIVE_KEY_ID,
          WALKZ_CREDENTIAL_KEYS_JSON: apiEnvironment.WALKZ_CREDENTIAL_KEYS_JSON,
          WALKZ_PUBLIC_URL: 'https://walkz.dev',
          WALKZ_TELEMETRY_HOST: '0.0.0.0',
          WALKZ_TELEMETRY_PORT: '3002',
        },
      },
      web: {
        ...hardenedService(images.web, ['edge']),
        environment: { WALKZ_API_URL: 'http://api:3001' },
        ports: [{ host_ip: '127.0.0.1', published: '3000', target: 3000 }],
      },
    },
    volumes: {
      'walkz-postgres-data': {},
      'walkz-proof-workspaces': {},
    },
  };
}

describe('production Compose contract', () => {
  it('accepts local image IDs and registry digests', () => {
    expect(validateImmutableImageReference(digest)).toBe(digest);
    expect(validateImmutableImageReference(`registry.example/walkz-api@${digest}`))
      .toBe(`registry.example/walkz-api@${digest}`);
  });

  it('rejects mutable image tags', () => {
    expect(() => validateImmutableImageReference('walkz-api:latest')).toThrow(
      /immutable image ID or registry digest/,
    );
  });

  it('accepts the isolated single-host topology', () => {
    expect(verifyProductionComposeModel(productionModel())).toEqual({
      images,
      publishedService: 'web',
      postgresVolume: 'walkz-postgres-data',
    });
  });

  it('rejects build instructions and internal service ports', () => {
    const model = productionModel();
    model.services.api.build = { context: '.' };
    model.services.postgres.ports = [{ published: '5432', target: 5432 }];
    let message = '';
    try {
      verifyProductionComposeModel(model);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/prebuilt images/);
    expect(message).toMatch(/only web may publish a host port/);
  });

  it('rejects root services and missing hardening', () => {
    const model = productionModel();
    model.services.worker.user = 'root';
    delete model.services.api.read_only;
    let message = '';
    try {
      verifyProductionComposeModel(model);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/worker must run as 1000:1000/);
    expect(message).toMatch(/api must use a read-only root filesystem/);
  });

  it('rejects a service without a PID 1 signal forwarder', () => {
    const model = productionModel();
    delete model.services.migrate.init;
    expect(() => verifyProductionComposeModel(model)).toThrow(
      /migrate must enable the Compose init process/,
    );
  });

  it('rejects missing internal worker telemetry health checks', () => {
    const model = productionModel();
    model.services.worker.expose = [];
    delete model.services.worker.healthcheck;
    model.services.worker.environment.WALKZ_TELEMETRY_HOST = '127.0.0.1';
    expect(() => verifyProductionComposeModel(model)).toThrow(
      /worker must expose telemetry port 3002.*worker must use its readiness endpoint.*worker telemetry must bind port 3002/s,
    );
  });

  it('rejects missing persistence and an exposed data network', () => {
    const model = productionModel();
    model.networks.data.internal = false;
    model.services.postgres.volumes = [];
    expect(() => verifyProductionComposeModel(model)).toThrow(
      /data network must be internal.*PostgreSQL data must use a named volume/,
    );
  });

  it('rejects placeholder and undersized secrets without echoing them', () => {
    const model = productionModel();
    model.services.api.environment.GITHUB_APP_ID = 'replace-with-app-id';
    model.services.api.environment.GITHUB_CLIENT_SECRET = 'replace-me';
    model.services.api.environment.GITHUB_WEBHOOK_SECRET = 'short';
    let message = '';
    try {
      verifyProductionComposeModel(model);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/GITHUB_APP_ID.*GITHUB_CLIENT_SECRET.*GITHUB_WEBHOOK_SECRET/);
    expect(message).not.toContain('replace-me');
  });

  it('renders Compose through a shell-free argument array', () => {
    let invocation;
    const model = renderProductionCompose({
      composeFile: 'C:\\walkz\\compose.production.yml',
      envFile: 'C:\\walkz\\production.env',
      run(command, arguments_, options) {
        invocation = { command, arguments_, options };
        return JSON.stringify({ services: {} });
      },
    });
    expect(model).toEqual({ services: {} });
    expect(invocation.command).toBe('docker');
    expect(invocation.arguments_).toEqual([
      'compose',
      '--env-file', 'C:\\walkz\\production.env',
      '--file', 'C:\\walkz\\compose.production.yml',
      'config',
      '--format', 'json',
    ]);
    expect(invocation.options.shell).toBe(false);
  });

  it('does not expose Docker output when rendering fails', () => {
    const secret = 'should-never-appear';
    expect(() => renderProductionCompose({
      composeFile: 'compose.yml',
      envFile: 'production.env',
      run() {
        throw new Error(secret);
      },
    })).toThrow(/could not render/);
    try {
      renderProductionCompose({
        composeFile: 'compose.yml',
        envFile: 'production.env',
        run() {
          throw new Error(secret);
        },
      });
    } catch (error) {
      expect(error.message).not.toContain(secret);
    }
  });
});
