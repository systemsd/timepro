/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // NOTE: `output: 'standalone'` was for the Docker image (apps/web/Dockerfile).
  // We deploy under PM2 with `next start`, which is incompatible with standalone
  // ("next start does not work with output: standalone"). Re-enable this only if
  // we move web back to the standalone/Docker runtime.
  // output: 'standalone',
};

export default nextConfig;
