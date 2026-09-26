import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json';
import { resolve } from 'node:path';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  // The pinned Sites starter ships workerd with this maximum supported date.
  compatibility_date: '2026-05-22',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  const nodeTarget = process.env.MOBIUP_RUNTIME === 'node';
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    resolve: { alias: { '#mobiup-runtime': resolve(nodeTarget ? 'lib/runtime-node.ts' : 'lib/runtime-cloudflare.ts'), '#mobiup-sales-parser': resolve(nodeTarget ? 'lib/sales-parser-node.ts' : 'lib/sales-parser-cloudflare.ts'), '#mobiup-stock-parser': resolve(nodeTarget ? 'lib/stock-parser-node.ts' : 'lib/stock-parser-cloudflare.ts'), '#mobiup-sales-view': resolve(nodeTarget ? 'lib/sales-view-node.ts' : 'lib/sales-view-direct.ts') } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      ...(!nodeTarget ? [sites(), cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      })] : []),
    ],
  };
});
