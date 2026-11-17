import { jobToolEnvironment } from './codex-environment.mjs';
import { readCommittedWriterBackend, readProjectConfig, selectWriterBackend }
  from './project-config.mjs';
import { requireThat } from './identity.mjs';

// One closure per launcher Job, after workspace establishment. Never cached globally.
export async function projectJob({
  workspace, runner, issue, observeMain, jobVm,
}, compose) {
  const target = runner.target ?? runner;
  requireThat(issue.repositoryId === target.repositoryId &&
    issue.repository === target.repository, 'HOST_WORKSPACE_SUBJECT_CHANGED');
  const project = await readProjectConfig(workspace.work,
    { ignoreWriterBackend: Boolean(observeMain) });
  const requested = observeMain
    ? readCommittedWriterBackend(await workspace.committedProjectConfig(
      (await observeMain()).head))
    : project.writerBackend;
  const writerBackend = selectWriterBackend(requested, jobVm);
  const projectRoot = workspace.work;
  const toolEnvironment = jobToolEnvironment(project.tools);
  return options => compose({ ...options, project, projectRoot, toolEnvironment,
    jobVm: writerBackend === 'firecracker' ? jobVm : undefined });
}
