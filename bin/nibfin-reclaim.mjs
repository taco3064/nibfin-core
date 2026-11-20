#!/usr/bin/env node
import { reclaimManagedStorage } from '../src/storage-reclamation-host.mjs';

if (process.argv.length !== 2 || process.getuid?.() !== 0) process.exit(1);
try {
  console.log(JSON.stringify(await reclaimManagedStorage()));
} catch {
  console.log(JSON.stringify({ status: 'unknown', platform: 'unsupported',
    attempted: null, filesystems: [] }));
}
