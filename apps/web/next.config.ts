import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@lodgent/shared'],
  poweredByHeader: false,
  agentRules: false,
};

export default config;
