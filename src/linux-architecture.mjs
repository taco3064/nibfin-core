export function linuxArchitecture(os, value) {
  if (os !== 'linux') return null;
  if (['x86_64', 'x64', 'amd64'].includes(value)) return 'amd64';
  if (['aarch64', 'arm64'].includes(value)) return 'arm64';
  return null;
}
