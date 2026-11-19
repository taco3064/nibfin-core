import { digest } from './identity.mjs';

const shapeStages = new Set(['shape', 'validate-shape', 'publish-shape']);

export async function refreshShapeWorkspace({
  workspace, stage, receipts, openPr, requirementsChanged, observeMain, settle,
}) {
  if (openPr || !['continue', 'shape'].includes(stage) ||
    !Object.keys(receipts).every(name => shapeStages.has(name))) return null;
  const prior = receipts.shape;
  const blockedReceipt = prior?.outcome === 'blocked' ? digest(prior) : null;
  if (stage !== 'shape' && prior && !blockedReceipt && !await requirementsChanged())
    return null;

  const base = await workspace.comparisonBase();
  const { head } = await observeMain();
  if (base !== head) {
    await settle();
    await workspace.refreshForShape(head, blockedReceipt);
    console.error(`Nibfin Shape workspace updated from ${base} to ${head}.`);
  }
  return blockedReceipt && await workspace.shapeRetryReceipt() === blockedReceipt
    ? blockedReceipt : null;
}
