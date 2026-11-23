/**
 * Variables a child tool may inherit from the Job. Everything else, such as
 * `GITHUB_TOKEN` or `GH_TOKEN`, stays with the stage code.
 */
const inheritedNames = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

function isInherited(name: string): boolean {
  return inheritedNames.has(name) || name.startsWith("LC_");
}

/**
 * The environment for an agent CLI, login-status command or rulesync: the
 * allowlisted parent variables plus `extra`.
 */
export function childEnvironment(
  parent: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const inherited = Object.entries(parent).filter(([name]) => isInherited(name));
  return { ...Object.fromEntries(inherited), ...extra };
}
