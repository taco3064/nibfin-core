import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './identity.mjs';
import { verifyNamespace } from './docker-backend.mjs';

const profile = 'codex-security-container';
const readLabel =
  "require('node:fs').writeSync(1," +
  "require('node:fs').readFileSync('/proc/self/attr/current'))";

// Docker's requested/inspect profile may be ignored by an unsupported daemon.
// This fixed probe has no credentials, host mounts, network or Agent input.
export async function verifyAppArmor(docker, image, namespace) {
  const name = `nibfin-apparmor-${randomUUID()}`;
  try {
    const result = await docker(
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--read-only',
        '--network',
        'none',
        '--ipc',
        'none',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        `--security-opt=apparmor=${profile}`,
        '--user',
        '1000:1000',
        '--pids-limit=32',
        '--memory=128m',
        '--cpus=1',
        '--entrypoint',
        '/usr/local/bin/node',
        image,
        '-e',
        namespace
          ? "const f=require('node:fs'); f.writeSync(1,JSON.stringify({" +
            "label:f.readFileSync('/proc/self/attr/current','utf8')," +
            "uidMap:f.readFileSync('/proc/self/uid_map','utf8')," +
            "gidMap:f.readFileSync('/proc/self/gid_map','utf8')}))"
          : readLabel,
      ],
      { timeout: 30000 },
    );
    const output = result.stdout.toString();
    const proof = namespace ? JSON.parse(output) : { label: output };
    const label = proof.label?.trim();
    requireThat(label === `${profile} (enforce)`, 'AGENT_APPARMOR_NOT_ENFORCED');
    if (namespace) verifyNamespace(proof, namespace);
    return digest({ profile, label, ...(namespace ? { namespace, proof } : {}) });
  } finally {
    const remaining = async () =>
      (await docker(['ps', '-aq', '--filter', `name=^/${name}$`])).stdout
        .toString()
        .trim();
    const id = await remaining();
    if (id) {
      requireThat(/^[a-f0-9]{12,64}$/.test(id), 'APPARMOR_PROBE_AMBIGUOUS');
      await docker(['rm', '--force', name]);
    }
    requireThat(!(await remaining()), 'APPARMOR_PROBE_TERMINATION_UNKNOWN');
  }
}
