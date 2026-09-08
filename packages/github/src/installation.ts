import { z } from 'zod';

const permissionSchema = z.enum(['read', 'write', 'none']);

export const installationAccessSchema = z
  .object({
    installationId: z.string().regex(/^[1-9][0-9]{0,18}$/),
    repositories: z.array(z.object({
      githubId: z.string().regex(/^[1-9][0-9]{0,18}$/),
      owner: z.string().trim().min(1).max(100),
      name: z.string().trim().min(1).max(100),
    }).strict()).min(1),
    permissions: z.object({
      metadata: permissionSchema,
      contents: permissionSchema,
      pullRequests: permissionSchema,
      checks: permissionSchema,
      issues: permissionSchema,
    }).strict(),
  })
  .strict();

export type InstallationAccess = z.infer<typeof installationAccessSchema>;

export function parseReadOnlyInstallation(input: unknown): InstallationAccess {
  const installation = installationAccessSchema.parse(input);
  if (
    installation.permissions.metadata !== 'read' ||
    installation.permissions.contents === 'write' ||
    installation.permissions.pullRequests === 'write'
  ) {
    throw new Error('Installation permissions exceed the read-only app boundary.');
  }
  return installation;
}
