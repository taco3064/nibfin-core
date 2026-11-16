import { createProxy } from './egress-proxy.mjs';

createProxy({ hosts: ['api.anthropic.com'] }).listen(3128, '0.0.0.0');
