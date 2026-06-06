// Base-aware URL helper for GitHub Pages project-site deployment.
// BASE_URL is '/Crypto-Women/' in project mode, '/' on a custom domain.
// Wrap every internal link and local asset path with withBase().
const BASE = import.meta.env.BASE_URL;

export function withBase(path: string): string {
  if (!path || !path.startsWith('/')) return path; // external or already-relative
  const base = BASE.endsWith('/') ? BASE.slice(0, -1) : BASE;
  return base + path;
}
