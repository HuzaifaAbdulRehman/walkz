function resolveBuildId(revision = process.env.WALKZ_SOURCE_REVISION) {
  if (revision === undefined || revision === 'development') {
    return 'development';
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('WALKZ_SOURCE_REVISION must be a full lowercase Git SHA.');
  }
  return revision;
}

module.exports = { resolveBuildId };
