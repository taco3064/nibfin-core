import { requireThat } from './identity.mjs';
import { engine, engineBackend } from './engine-contract.mjs';

import { rootfulNamespaceSize as size } from './docker-backend.mjs';
const maximum = 4294967296;
const overlaps = (a, b) => a.start < b.start + b.size && b.start < a.start + a.size;

export function subordinateRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([a-z_][a-z0-9_-]*|[0-9]+):([0-9]+):([0-9]+)$/.exec(line);
    requireThat(match, 'ENGINE_SUBID_MALFORMED');
    const row = { owner: match[1], start: Number(match[2]), size: Number(match[3]) };
    requireThat(Number.isSafeInteger(row.start) && Number.isSafeInteger(row.size) &&
      row.start >= size && row.size > 0 && row.start + row.size <= maximum,
    'ENGINE_SUBID_MALFORMED');
    requireThat(!rows.some(other => overlaps(row, other)), 'ENGINE_SUBID_OVERLAP');
    rows.push(row);
  }
  return rows;
}

export function allocateSubordinate(text, identities, accountId, intended) {
  const rows = subordinateRows(text);
  requireThat(identities.length > 0 && identities.every(id =>
    Number.isSafeInteger(id) && id >= 0 && id < maximum),
  'ENGINE_PROTECTED_IDENTITIES_UNPROVEN');
  const protectedRanges = identities.map(start => ({ start, size: 1 }));
  requireThat(rows.every(row => !protectedRanges.some(id => overlaps(row, id))),
    'ENGINE_SUBID_PROTECTED_IDENTITY');
  const own = rows.filter(row => [engine.remap, String(accountId)].includes(row.owner));
  requireThat(own.length <= 1, 'ENGINE_SUBID_AMBIGUOUS');
  if (own.length) {
    requireThat(own[0].owner === engine.remap && own[0].size === size &&
      intended !== undefined && intended === own[0].start,
    'ENGINE_SUBID_OWNERSHIP_UNPROVEN');
    return own[0].start;
  }
  const occupied = [...rows, ...protectedRanges];
  let start = intended ?? size;
  while (occupied.some(row => overlaps({ start, size }, row))) {
    requireThat(intended === undefined, 'ENGINE_SUBID_CONFLICT');
    start = Math.max(...occupied.filter(row => overlaps({ start, size }, row))
      .map(row => row.start + row.size));
  }
  requireThat(start >= size && start + size <= maximum, 'ENGINE_SUBID_EXHAUSTED');
  return start;
}

export function allocationPlan(tables, identities, account, previous) {
  const namespace = { size };
  for (const [table, field] of [['subuid', 'uidStart'], ['subgid', 'gidStart']]) {
    namespace[field] = allocateSubordinate(tables[table], identities[table],
      account[table], previous?.[field]);
  }
  engineBackend(namespace);
  return namespace;
}

export function verifySubordinateChange(before, after, start) {
  const oldRows = subordinateRows(before);
  const newRows = subordinateRows(after);
  const intended = { owner: engine.remap, start, size };
  const expected = oldRows.some(row => row.owner === engine.remap)
    ? oldRows : [...oldRows, intended];
  requireThat(JSON.stringify(newRows) === JSON.stringify(expected),
    'ENGINE_SUBID_RECONCILIATION_REQUIRED');
}
