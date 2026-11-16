import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import { optionalStat } from './retirement-files.mjs';
import {
  slotParent, slotUnit, disabledRetirementUnit, assertNoSlotMounts,
} from './retirement-observe.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export const retirementSlotEffects = [1, 2].flatMap(slot =>
  [`disable-${slot}`, `quarantine-${slot}`, `delete-${slot}`]);

// Test ports model two services; the installed administrator uses fixed defaults.
// Names, registration bindings and inode checks remain code-owned in both cases.
export class RetirementSlotResources {
  constructor({ parent = slotParent, run = command, inspect = rootOwnedPath } = {}) {
    this.parent = parent;
    this.run = run;
    this.inspect = inspect;
  }
  paths(name, state) {
    requireThat(retirementSlotEffects.includes(name), 'RETIREMENT_EFFECT_INVALID');
    const [kind, slotText] = name.split('-'), slot = Number(slotText);
    requireThat(/^[a-f0-9-]{36}$/.test(state.id), 'RETIREMENT_STATE_INVALID');
    const binding = state.binding.slots[slot - 1];
    const path = join(this.parent, `slot-${slot}`);
    requireThat(binding.slot === slot && binding.path === path &&
      binding.service === slotUnit(slot), 'RETIREMENT_RESOURCE_CHANGED');
    return { kind, slot, binding, path,
      quarantine: join(this.parent, `.retired-${state.id}-${slot}`) };
  }
  async requireResource(path, identity) {
    await this.inspect(this.parent);
    await this.inspect(path);
    const stat = await optionalStat(path);
    requireThat(stat?.isDirectory() && stat.dev === identity.dev &&
      stat.ino === identity.ino, 'RETIREMENT_RESOURCE_CHANGED');
  }
  async observe(name, state) {
    const { kind, slot, binding, path, quarantine } = this.paths(name, state);
    const source = await optionalStat(path), retired = await optionalStat(quarantine);
    if (source) {
      await this.requireResource(path, binding.identity);
      await verifySharedSlotIdentity(path, binding.runner, state.binding.pool.repository,
        { inspect: this.inspect });
    }
    if (retired) {
      await this.requireResource(quarantine, binding.identity);
      await verifySharedSlotIdentity(quarantine, binding.runner,
        state.binding.pool.repository, { inspect: this.inspect,
          allowRemoved: Boolean(state.effects[`delete-${slot}`]) });
    }
    requireThat(!(source && retired), 'RETIREMENT_RESOURCE_CHANGED');
    if (kind === 'disable') {
      const disabled = await disabledRetirementUnit(slot, this.run, this.inspect);
      return disabled ? 'done' : 'absent';
    }
    if (kind === 'quarantine') {
      if (!source && retired) return 'done';
      if (!source && !retired && state.effects[`delete-${slot}`]) return 'done';
      requireThat(source && !retired, 'RETIREMENT_RESOURCE_CHANGED');
      return 'absent';
    }
    requireThat(state.effects[`quarantine-${slot}`] === 'done' && !source,
      'RETIREMENT_RESOURCE_CHANGED');
    return retired ? 'absent' : 'done';
  }
  async perform(name, state) {
    const { kind, slot, binding, path, quarantine } = this.paths(name, state);
    await this.observe(name, state);
    if (kind === 'disable') {
      await this.inspect('/usr/bin/systemctl');
      await this.run('/usr/bin/systemctl', ['disable', slotUnit(slot)],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 8192 });
    } else if (kind === 'quarantine') {
      await assertNoSlotMounts(path);
      await this.requireResource(path, binding.identity);
      requireThat(!await optionalStat(quarantine), 'RETIREMENT_RESOURCE_CHANGED');
      await rename(path, quarantine);
      await syncRecoveryDirectory(this.parent);
    } else {
      await assertNoSlotMounts(quarantine);
      await this.requireResource(quarantine, binding.identity);
      await rm(quarantine, { recursive: true });
      await syncRecoveryDirectory(this.parent);
    }
  }
}
