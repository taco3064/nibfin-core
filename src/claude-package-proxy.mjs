import { createProxy, toolDownloadHosts } from './egress-proxy.mjs';

// Package downloads only. No provider login or user MCP delegation is exposed.
createProxy({ hosts: toolDownloadHosts }).listen(3128, '0.0.0.0');
