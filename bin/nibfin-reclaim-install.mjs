#!/usr/bin/env node
import { installStorageReclamation } from '../src/storage-reclamation-install.mjs';

if (process.argv.length !== 2 || process.getuid?.() !== 0) process.exit(1);
await installStorageReclamation();
