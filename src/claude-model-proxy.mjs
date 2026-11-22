import { createProxy, modelHosts } from './egress-proxy.mjs';

createProxy({ hosts: modelHosts.claude }).listen(3128, '0.0.0.0');
