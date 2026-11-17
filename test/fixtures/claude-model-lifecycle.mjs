import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fixture } from './claude-lifecycle.mjs';
import { createClaudePrivateRunner, claudeModelComponent }
  from '../../src/claude-model-runner.mjs';
import { claudePlan } from '../../src/claude-plan.mjs';
import { digest } from '../../src/identity.mjs';
import { modelEntry, fixedNode } from '../../src/claude-model-container.mjs';

export async function modelFixture() {
  const f = await fixture();
  const abort = new AbortController();
  const modelId = 'd'.repeat(64);
  const key = 'sk-ant-' + 'synthetic'.repeat(8);
  const modelEgress = { ...f.egress, gatewayId: 'e'.repeat(64),
    network: f.egress.network.replace('work', 'model') };
  await writeFile(join(f.egress.directory, 'claude-model-proxy.mjs'),
    await readFile('src/claude-model-proxy.mjs'));
  const plan = claudePlan('deliver', { context: {},
    skill: { identity: 'deliver', content: 'Protected', hash: digest('Protected') },
    modelProfile: { model: 'claude-configured' } }, claudeModelComponent);
  const controls = { modelUnknown: false, modelLostCreate: false,
    workerGone: false, channelGone: false, modelExists: false };
  const calls = [];
  let model, finish;
  const host = { ...f.host, lstat: async path => {
    if (controls.channelGone && path.endsWith('worker.sock'))
      throw Object.assign(new Error('socket lost'), { code: 'ENOENT' });
    return f.host.lstat(path);
  } };
  const run = async (exe, args, options) => {
    const cmd = args.slice(2);
    calls.push(cmd);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!args.some(arg => arg.includes(key)));
    const reply = value => ({ stdout: Buffer.from(typeof value === 'string' ? value :
      JSON.stringify(value)), stderr: Buffer.alloc(0), exitCode: 0 });
    if (cmd[0] === 'create' && cmd.includes('--user=1001:1001')) {
      controls.modelExists = true;
      model = { Id: modelId, Name: '/' + cmd[cmd.indexOf('--name') + 1],
        State: { Status: 'created' }, AppArmorProfile: 'codex-security-container',
        Config: { Image: f.config.image, User: '1001:1001', WorkingDir: '/session',
          OpenStdin: true, Entrypoint: [fixedNode], Cmd: [modelEntry, ...plan.args],
          Env: cmd.flatMap((arg, i) => arg === '--env' ? [cmd[i + 1]] : []) },
        HostConfig: { LogConfig: { Type: 'none' }, Privileged: false,
          ReadonlyRootfs: true, NetworkMode: modelEgress.network,
          Dns: ['127.0.0.1'], IpcMode: 'none', Memory: 2147483648,
          MemorySwap: 2147483648, NanoCpus: 1000000000, PidsLimit: 128,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges', 'apparmor=codex-security-container'],
          Tmpfs: Object.fromEntries(cmd.filter(arg => arg.startsWith('--tmpfs='))
            .map(arg => arg.slice(8).split(/:(.*)/s).slice(0, 2))) },
        Mounts: [{ Type: 'bind', Source: join(f.admission.session, 'work-channel'),
          Destination: '/session/work-channel', RW: false, Propagation: 'rprivate' }],
        NetworkSettings: { Networks: { [modelEgress.network]: {} } },
      };
      await controls.creating?.();
      if (controls.modelLostCreate) throw new Error('lost private create');
      return reply(modelId);
    }
    if (cmd[0] === 'inspect' && cmd[1] === modelId) return reply([model]);
    if (cmd[0] === 'start' && cmd[1] === '-ai') {
      assert.equal(JSON.parse(options.input).key, key);
      await controls.executing?.();
      if (controls.modelFailure) throw new Error(key);
      if (controls.hold) return new Promise(resolve => { finish = resolve; });
      return reply('model output');
    }
    if (cmd[0] === 'ps' && cmd.at(-1).includes('nibfin-claude-model-')) {
      if (controls.modelUnknown) throw new Error('model daemon unreachable');
      return reply(controls.modelExists ? modelId : '');
    }
    if (cmd[0] === 'rm' && cmd.at(-1).startsWith('nibfin-claude-model-')) {
      controls.modelExists = false;
      finish?.(reply('late successful model output'));
      return reply('');
    }
    if (cmd[0] === 'image') {
      const value = JSON.parse((await f.run(exe, args, options)).stdout);
      value[0].Config.Labels = {
        'io.nibfin.claude-version': claudeModelComponent.cli.version };
      return reply(value);
    }
    if (cmd[0] === 'network' && cmd.at(-1) === modelEgress.network ||
      cmd[0] === 'inspect' && cmd[1] === modelEgress.gatewayId) {
      const translated = args.map(arg => arg === modelEgress.network ?
        f.egress.network : arg === modelEgress.gatewayId ? f.egress.gatewayId : arg);
      const value = (await f.run(exe, translated, options)).stdout.toString()
        .replaceAll(f.egress.network, modelEgress.network)
        .replaceAll(f.egress.gatewayId, modelEgress.gatewayId)
        .replaceAll('claude-package-proxy.mjs', 'claude-model-proxy.mjs');
      return reply(value);
    }
    const result = await f.run(exe, args, options);
    if (cmd[0] === 'inspect' && cmd[1] === 'b'.repeat(64) &&
      (controls.workerGone || controls.workerCompleted)) {
      const value = JSON.parse(result.stdout);
      value[0].State = { Running: false, Status: 'exited',
        ExitCode: controls.workerCompleted ? 0 : 1 };
      return reply(value);
    }
    return result;
  };
  const runner = createClaudePrivateRunner({ ...f.config, modelEgress,
    worker: { container: f.config, mounts: f.admission, egress: f.egress } },
  { run, host, backend: f.backend, signal: abort.signal, readKey: async () => key });
  const execute = () => runner.execute({ plan, executionId: f.admission.executionId,
    session: f.admission.session });
  return { ...f, modelControls: controls,
    workerControls: f.controls, runner, abort, execute, plan, key, calls,
    admissionFile: join(f.admission.session, 'work-admission.json'),
    channel: dirname(join(f.admission.session, 'work-channel', 'worker.sock')) };
}
