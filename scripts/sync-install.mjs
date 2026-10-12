// Syncs scripts/install.sh -> public/install.sh and
// scripts/install.ps1 -> public/install.ps1 before `vite build`.
// Single source of truth stays in scripts/; public/ copies are
// generated (gitignored) so `vite build` ships them as dist/install.*,
// served from every Worker host (cd.yash0.in, cd.yash0.in) via static assets.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'public'), { recursive: true });
copyFileSync(join(root, 'scripts', 'install.sh'), join(root, 'public', 'install.sh'));
copyFileSync(join(root, 'scripts', 'install.ps1'), join(root, 'public', 'install.ps1'));
console.log('install: synced scripts/install.sh -> public/install.sh');
console.log('install: synced scripts/install.ps1 -> public/install.ps1');
