import { writeFile } from 'node:fs/promises';

// Only for the launcher's private empty /etc tmpfs. Native sudo and visudo use
// normal NSS identity lookup even when the calling process already has UID 0.
export async function prepareMaintenanceRootIdentity() {
  await writeFile('/etc/passwd', 'root:x:0:0:Fixture root:/nonexistent:/bin/sh\n');
  await writeFile('/etc/group', 'root:x:0:\n');
  await writeFile('/etc/nsswitch.conf', 'passwd: files\ngroup: files\n');
}
