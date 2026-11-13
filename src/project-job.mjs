import { jobToolEnvironment } from './codex-environment.mjs';
import { readProjectConfig } from './project-config.mjs';
import { requireThat } from './identity.mjs';

// One closure per launcher Job, after workspace establishment. Never cached globally.
export async function projectJob({ workspace, runner, issue }, compose) {
  const target = runner.target ?? runner;
  requireThat(issue.repositoryId === target.repositoryId &&
    issue.repository === target.repository, 'HOST_WORKSPACE_SUBJECT_CHANGED');
  const project = await readProjectConfig(workspace.work);
  const projectRoot = workspace.work;
  const toolEnvironment = jobToolEnvironment(project.tools);
  return options => compose({ ...options, project, projectRoot, toolEnvironment });
}
