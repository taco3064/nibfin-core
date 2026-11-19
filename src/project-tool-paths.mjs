// Tool-owned disposable output is separate from Core login and control state.
// Both providers use this role distinction and the same standard environment.
export function projectToolPaths(writable, executionId) {
  const root = projectToolRoot(writable, executionId);
  const home = root + '/home', temporary = root + '/tmp';
  return {
    HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CACHE_HOME: root + '/cache', XDG_CONFIG_HOME: root + '/config',
    GOCACHE: root + '/cache/go-build', GOPATH: root + '/go',
    PIP_CACHE_DIR: root + '/cache/pip', npm_config_cache: root + '/cache/npm',
  };
}

export function projectToolRoot(writable, executionId) {
  const key = /^[a-f0-9-]{36}$/i.test(executionId ?? '') ? executionId : 'tools';
  return writable ? '/work/.nibfin-cache/' + key : '/tmp/tool-cache';
}

export function projectToolDirectories(writable, executionId) {
  return [...new Set(Object.values(projectToolPaths(writable, executionId)))];
}

// A private tmpfs belongs to the admitted tool UID, including in a nested
// sandbox where container root may be represented by an unmapped identity.
export const toolScratchOptions =
  'rw,exec,nosuid,nodev,size=2g,mode=0700,uid=1000,gid=1000';
