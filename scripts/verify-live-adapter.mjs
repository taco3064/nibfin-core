// The existing native CI entry point covers default and prepared images.
import { verifyLiveAdapter } from './live-adapter-probe.mjs';
import { verifyLiveToolEnvironments } from './verify-live-tool-environments.mjs';

await verifyLiveAdapter();
await verifyLiveToolEnvironments();
