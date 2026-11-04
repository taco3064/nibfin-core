import { dockerBackend, rootfulSocket } from '../src/docker-backend.mjs';

// Diagnostic configuration only: these scripts never admit an Issue or copy a
// real login. The product always obtains its backend from root-owned adoption.
export function liveDockerProfile(env = process.env) {
  const kind = env.NIBFIN_TEST_BACKEND ?? 'linux-rootless-docker-v1';
  const backend = dockerBackend({
    kind,
    ...(kind === 'linux-rootful-docker-v1'
      ? { namespace: JSON.parse(env.NIBFIN_TEST_NAMESPACE ?? 'null') }
      : {}),
  });
  const socket =
    backend.mode === 'rootful'
      ? rootfulSocket
      : `/run/user/${process.getuid()}/docker.sock`;
  return { backend, socket };
}
