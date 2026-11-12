import { requireThat, isId } from './identity.mjs';

export const controllerProgram = '/opt/nibfin/core/bin/nibfin-controller';
export const controllerRelayProgram = '/usr/bin/sudo';

export function controllerRelayArguments(uid) {
  return ['-n', '-u', `#${uid}`, '--', controllerProgram];
}

export const contextKeys = Object.freeze([
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_EVENT_NAME',
  'RUNNER_ENVIRONMENT',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
]);

export const targetContextKey = 'NIBFIN_TARGET_REPOSITORY_ID';

export function controllerRoute(host) {
  const issues = Object.values(host.issues ?? {});
  if (host.repository) issues.push(host.repository);
  if (host.runnerUid === undefined) {
    requireThat(
      !issues.some((x) => x.isolation?.kind === 'linux-rootful-docker-v1'),
      'CONTROLLER_SEPARATION_REQUIRED',
    );
    return false;
  }
  requireThat(
    isId(host.uid) &&
      isId(host.runnerUid) &&
      host.uid < 65536 &&
      host.runnerUid < 65536 &&
      host.uid !== host.runnerUid &&
      issues.length > 0 &&
      issues.every((x) => x.isolation?.kind === 'linux-rootful-docker-v1'),
    'INVALID_CONTROLLER_SEPARATION',
  );
  return true;
}

export function validateControllerRequest(value) {
  requireThat(
    value &&
      value.schemaVersion === 1 &&
      ['stage', 'dispatch-event'].includes(value.command) &&
      /^[1-9][0-9]*$/.test(value.issue) &&
      isId(Number(value.issue)) &&
      Object.keys(value).sort().join(',') ===
        (value.command === 'stage'
          ? 'command,context,issue,schemaVersion,stage'
          : 'command,context,event,issue,schemaVersion'),
    'INVALID_CONTROLLER_REQUEST',
  );
  requireThat(
    value.context &&
      Object.keys(value.context).every((key) =>
        contextKeys.includes(key) || key === targetContextKey) &&
      (value.context[targetContextKey] === undefined ||
        (typeof value.context[targetContextKey] === 'string' &&
          /^[1-9][0-9]*$/.test(value.context[targetContextKey]) &&
          isId(Number(value.context[targetContextKey])))) &&
      contextKeys.every(
        (key) =>
          typeof value.context[key] === 'string' &&
          value.context[key].length > 0 &&
          value.context[key].length <= 32768,
      ),
    'INVALID_CONTROLLER_CONTEXT',
  );
  requireThat(
    value.command === 'stage'
      ? typeof value.stage === 'string' && /^[a-z][a-z-]{0,39}$/.test(value.stage)
      : typeof value.event === 'string' && Buffer.byteLength(value.event) <= 1048576,
    'INVALID_CONTROLLER_REQUEST',
  );
  return value;
}

export async function readControllerInput(stream) {
  const chunks = [];
  let size = 0;
  for await (const bytes of stream) {
    size += bytes.length;
    requireThat(size <= 2 * 1048576, 'CONTROLLER_REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return validateControllerRequest(JSON.parse(Buffer.concat(chunks).toString()));
}
