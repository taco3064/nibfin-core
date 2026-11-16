#!/usr/bin/env node
import {
  prepareNotificationRelay, inspectNotificationRelay, controlNotificationRelay,
  pollNotificationRelay,
} from '../src/relay-service.mjs';
import { requireThat } from '../src/identity.mjs';
import { safeRelayCode } from '../src/notification-relay.mjs';

const commands = {
  prepare: prepareNotificationRelay,
  inspect: inspectNotificationRelay,
  pause: () => controlNotificationRelay(true),
  resume: () => controlNotificationRelay(false),
  poll: pollNotificationRelay,
};
async function main(args) {
  requireThat(args.length === 1 && Object.hasOwn(commands, args[0]),
    'INVALID_RELAY_COMMAND');
  return commands[args[0]]();
}
main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'denied') process.exitCode = 1;
  if (result.status === 'pending') process.exitCode = 2;
}).catch(error => {
  process.stderr.write(JSON.stringify({ status: 'denied',
    code: safeRelayCode(error) }) + '\n');
  process.exitCode = 1;
});
