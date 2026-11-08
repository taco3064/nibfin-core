import { canonical } from './identity.mjs';
import { validateSchema } from './schema.mjs';

export const candidateContractFence = 'kairo-candidate';
export const candidateContractSchema = {
  type: 'object', additionalProperties: false, required: ['artifacts', 'hooks'],
  properties: {
    artifacts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'purpose'],
        properties: { path: { type: 'string' }, purpose: { type: 'string' } },
      },
    },
    hooks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'event'],
        properties: {
          path: { type: 'string' },
          event: {
            type: 'string', enum: ['pre-commit', 'prepare-commit-msg', 'commit-msg'],
          },
        },
      },
    },
  },
};

// The Agent receives the same syntax and schema that Core actually enforces.
export function candidateRuntimeContract() {
  return { fence: candidateContractFence, schema: candidateContractSchema };
}

export function safeCandidatePath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/.test(path) &&
    path.split('/').every(p => p && !['.', '..', '.git'].includes(p.toLowerCase()));
}

function candidateBlockPattern() {
  return new RegExp(
    '^```' + candidateContractFence + '\\r?\\n([\\s\\S]*?)^```\\s*$', 'gm',
  );
}

export function candidateContract(body) {
  const blocks = [...(body || '').matchAll(candidateBlockPattern())];
  if (blocks.length !== 1) {
    throw new Error(
      `Shape must contain exactly one ${candidateContractFence} obligations block`,
    );
  }
  const contract = validateSchema(JSON.parse(blocks[0][1]), candidateContractSchema);
  for (const kind of ['artifacts', 'hooks']) {
    if (new Set(contract[kind].map(x => x.path)).size !== contract[kind].length) {
      throw new Error('Duplicate candidate obligation');
    }
    for (const entry of contract[kind]) {
      if (!safeCandidatePath(entry.path) ||
          (kind === 'artifacts' && !entry.purpose.trim())) {
        throw new Error('Invalid candidate obligation path or purpose');
      }
    }
  }
  return contract;
}

export function canonicalCandidateBlock(body) {
  if (typeof body !== 'string') return body;
  let contract;
  try { contract = candidateContract(body); }
  catch { return body; }
  return body.replace(candidateBlockPattern(), (block, json) => {
    const start = block.indexOf('\n') + 1;
    return block.slice(0, start) + canonical(contract) + '\n' +
      block.slice(start + json.length);
  });
}
