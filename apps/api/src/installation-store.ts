import { createDefaultWalkzConfig } from '@walkz/contracts';
import type { InstallationRepositoryCatalogFactory } from '@walkz/github';
import {
  listGrantedRepositories,
  selectGrantedRepository,
} from '@walkz/persistence';

import type { InstallationRepositoryStore } from './installation-api.js';

type RepositorySelectionPool =
  Parameters<typeof listGrantedRepositories>[0] &
  Parameters<typeof selectGrantedRepository>[0];

export function createPersistentInstallationRepositoryStore(
  pool: RepositorySelectionPool,
  catalogs: InstallationRepositoryCatalogFactory,
): InstallationRepositoryStore {
  return {
    async list(input) {
      const [grants, catalog] = await Promise.all([
        listGrantedRepositories(pool, input),
        catalogs.forInstallation(input.installationId),
      ]);
      const repositories = await catalog.list();
      const grantsByRepository = new Map(
        grants.map((grant) => [grant.githubId, grant]),
      );
      return repositories.flatMap((repository) => {
        const grant = grantsByRepository.get(repository.githubId);
        if (grant === undefined) return [];
        return [{
          id: repository.githubId,
          owner: repository.owner,
          name: repository.name,
          selectedRepositoryId: grant.selectedRepositoryId,
        }];
      });
    },

    async select(input) {
      const catalog = await catalogs.forInstallation(input.installationId);
      const repositories = await catalog.list();
      const repository = repositories.find((item) => item.githubId === input.repositoryId);
      if (repository === undefined) {
        throw new Error('Repository access was not found.');
      }
      await selectGrantedRepository(pool, {
        userId: input.userId,
        installationId: input.installationId,
        repository,
        config: createDefaultWalkzConfig(),
      });
    },
  };
}
