import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digest, isDigest, requireThat } from './identity.mjs';

const roleSkills = Object.freeze({ shape: 'shape', 'validate-shape': 'shape', 'review-pr': 'shape', deliver: 'deliver', accept: 'accept' });
export function skillIdentity(stage) {
  requireThat(Object.hasOwn(roleSkills, stage), 'UNKNOWN_AGENT_ROLE'); return roleSkills[stage];
}
export async function readSkill(coreRoot, stage, expectedHash) {
  const identity = skillIdentity(stage), root = resolve(coreRoot), path = join(root, 'skills', identity, 'SKILL.md');
  requireThat(isDigest(expectedHash) && await realpath(path) === path, 'UNTRUSTED_SKILL_PATH');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content;
  try {
    const stat = await handle.stat(); requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= 128 * 1024, 'UNSAFE_SKILL_FILE');
    content = await handle.readFile('utf8');
  } finally { await handle.close(); }
  requireThat(content.startsWith(`---\nname: ${identity}\n`) && digest(content) === expectedHash, 'SKILL_IDENTITY_CHANGED');
  return { identity, stage, hash: expectedHash, content };
}
