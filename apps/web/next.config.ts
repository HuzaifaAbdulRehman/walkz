import type { NextConfig } from 'next';

import { resolveBuildId } from './build-id.cjs';

const nextConfig: NextConfig = {
  generateBuildId: async () => resolveBuildId(),
  reactStrictMode: true,
};

export default nextConfig;
