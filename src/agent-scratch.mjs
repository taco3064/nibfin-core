// Each role has its own disposable mount. It belongs to the role UID rather
// than unmapped container root, so ordinary private fixtures retain meaningful
// ownership checks inside the nested command sandbox.
export const agentScratchOptions =
  'rw,exec,nosuid,nodev,size=2g,mode=0700,uid=1000,gid=1000';
export const agentScratchMount = '/tmp:' + agentScratchOptions;
