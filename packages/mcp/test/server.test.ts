import {
  Client,
  InMemoryTransport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWalkzMcpServer,
  WALKZ_MCP_TOOL_NAMES,
  WalkzMcpToolError,
  type WalkzMcpService,
} from '../src/index.js';

const ids = {
  grant: '11111111-1111-4111-8111-111111111111',
  subject: '22222222-2222-4222-8222-222222222222',
  repository: '33333333-3333-4333-8333-333333333333',
  request: '44444444-4444-4444-8444-444444444444',
  review: '55555555-5555-4555-8555-555555555555',
  finding: '66666666-6666-4666-8666-666666666666',
  operation: '77777777-7777-4777-8777-777777777777',
  proposal: '88888888-8888-4888-8888-888888888888',
};
const headSha = 'a'.repeat(40);
const grant = {
  grantId: ids.grant,
  audience: 'walkz-mcp',
  subjectId: ids.subject,
  repositoryId: ids.repository,
  capabilities: ['read', 'prove', 'fix'],
  issuedAt: '2026-09-13T12:00:00.000Z',
  expiresAt: '2026-09-13T12:15:00.000Z',
};

const readOutput = {
  reviewRunId: ids.review,
  headSha,
  status: 'completed',
  verdict: 'FIX',
  summary: 'One verified regression.',
  findings: [{
    findingId: ids.finding,
    evidenceLevel: 'VERIFIED',
    lifecycleStatus: 'verified',
    severity: 'high',
    summary: 'A bounded finding.',
    path: 'src/example.ts',
    startLine: 2,
    endLine: 2,
  }],
};

const service = (): WalkzMcpService => ({
  readReview: vi.fn().mockResolvedValue(readOutput),
  requestProof: vi.fn().mockResolvedValue({
    operationId: ids.operation,
    requestId: ids.request,
    reviewRunId: ids.review,
    findingId: ids.finding,
    headSha,
    status: 'queued',
  }),
  prepareFixProposal: vi.fn().mockResolvedValue({
    proposalId: ids.proposal,
    requestId: ids.request,
    reviewRunId: ids.review,
    findingId: ids.finding,
    headSha,
    patchHash: 'b'.repeat(64),
    status: 'awaiting_human',
    approvalRequired: true,
  }),
});

const clients: Client[] = [];
const servers: ReturnType<typeof createWalkzMcpServer>[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function connect(
  capabilities = grant.capabilities,
  selectedService = service(),
  now = () => new Date('2026-09-13T12:05:00.000Z'),
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWalkzMcpServer({
    grant: { ...grant, capabilities },
    service: selectedService,
    now,
  });
  const client = new Client({ name: 'walkz-test', version: '1.0.0' });
  servers.push(server);
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, selectedService };
}

describe('Walkz MCP server', () => {
  it('advertises only granted tools with cautious annotations', async () => {
    const selectedService = service();
    const { client } = await connect(['read'], selectedService);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: WALKZ_MCP_TOOL_NAMES.read,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    await expect(client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.fix,
      arguments: {
        requestId: ids.request,
        reviewRunId: ids.review,
        findingId: ids.finding,
        expectedHeadSha: headSha,
      },
    })).rejects.toThrow(/not found/i);
    expect(selectedService.prepareFixProposal).not.toHaveBeenCalled();
  });

  it('uses server-bound identity and repository context', async () => {
    const selectedService = service();
    const { client } = await connect(grant.capabilities, selectedService);

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.read,
      arguments: { reviewRunId: ids.review },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(readOutput);
    expect(selectedService.readReview).toHaveBeenCalledWith(
      { reviewRunId: ids.review },
      expect.objectContaining({
        grantId: ids.grant,
        subjectId: ids.subject,
        repositoryId: ids.repository,
        capability: 'read',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects prompt-supplied authority before invoking the service', async () => {
    const selectedService = service();
    const { client } = await connect(grant.capabilities, selectedService);

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.fix,
      arguments: {
        requestId: ids.request,
        reviewRunId: ids.review,
        findingId: ids.finding,
        expectedHeadSha: headSha,
        repositoryId: '99999999-9999-4999-8999-999999999999',
        approved: true,
        patch: 'attacker-controlled patch',
      },
    });

    expect(result.isError).toBe(true);
    expect(selectedService.prepareFixProposal).not.toHaveBeenCalled();
  });

  it('fails closed when a grant expires after discovery', async () => {
    const selectedService = service();
    const { client } = await connect(
      grant.capabilities,
      selectedService,
      () => new Date('2026-09-13T12:15:00.000Z'),
    );

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.prove,
      arguments: {
        requestId: ids.request,
        reviewRunId: ids.review,
        findingId: ids.finding,
        expectedHeadSha: headSha,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: 'text',
      text: 'grant_expired: The Walkz MCP grant has expired.',
    }]);
    expect(selectedService.requestProof).not.toHaveBeenCalled();
  });

  it('fails closed before the grant activation time', async () => {
    const selectedService = service();
    const { client } = await connect(
      grant.capabilities,
      selectedService,
      () => new Date('2026-09-13T11:59:59.999Z'),
    );

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.read,
      arguments: { reviewRunId: ids.review },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{
        type: 'text',
        text: 'grant_not_active: The Walkz MCP grant is not active yet.',
      }],
    });
    expect(selectedService.readReview).not.toHaveBeenCalled();
  });

  it('returns only approval-gated fix metadata', async () => {
    const selectedService = service();
    const { client } = await connect(grant.capabilities, selectedService);

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.fix,
      arguments: {
        requestId: ids.request,
        reviewRunId: ids.review,
        findingId: ids.finding,
        expectedHeadSha: headSha,
      },
    });

    expect(result.structuredContent).toEqual(expect.objectContaining({
      status: 'awaiting_human',
      approvalRequired: true,
      patchHash: 'b'.repeat(64),
    }));
    expect(JSON.stringify(result)).not.toContain('patchText');
    expect(selectedService.prepareFixProposal).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: headSha }),
      expect.objectContaining({ repositoryId: ids.repository, capability: 'fix' }),
    );
  });

  it('maps internal failures to bounded messages without leaking details', async () => {
    const selectedService = service();
    vi.mocked(selectedService.readReview).mockRejectedValue(
      new Error('database password secret-value'),
    );
    const { client } = await connect(grant.capabilities, selectedService);

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.read,
      arguments: { reviewRunId: ids.review },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('unavailable');
    expect(JSON.stringify(result)).not.toContain('database password');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('fails closed when a service returns an invalid output boundary', async () => {
    const selectedService = service();
    vi.mocked(selectedService.readReview).mockResolvedValue({
      ...readOutput,
      findings: Array.from({ length: 51 }, () => readOutput.findings[0]),
    });
    const { client } = await connect(grant.capabilities, selectedService);

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.read,
      arguments: { reviewRunId: ids.review },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('unavailable');
    expect(result.structuredContent).toBeUndefined();
  });

  it('preserves explicit safe service failures', async () => {
    const selectedService = service();
    vi.mocked(selectedService.requestProof).mockRejectedValue(
      new WalkzMcpToolError('stale_head'),
    );
    const { client } = await connect(grant.capabilities, selectedService);

    const result = await client.callTool({
      name: WALKZ_MCP_TOOL_NAMES.prove,
      arguments: {
        requestId: ids.request,
        reviewRunId: ids.review,
        findingId: ids.finding,
        expectedHeadSha: headSha,
      },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('stale_head') }],
    });
  });
});
