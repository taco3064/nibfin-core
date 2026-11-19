import { slotParent, slotUnit } from './retirement-observe.mjs';

// Slot locations and service/UID routing are shared installation facts. Product
// promotion enrollment policy belongs to its caller, not to these descriptors.
export function sharedPoolSlots(pool, host) {
  return pool.runners.map((runner, index) => {
    const slot = index + 1;
    return { slot, path: `${slotParent}/slot-${slot}`, runner,
      service: slotUnit(slot),
      uid: index ? host.sharedRunner.additionalRunner.uid : host.runnerUid };
  });
}
