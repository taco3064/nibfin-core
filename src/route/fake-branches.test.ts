// Shared test support for branch deletion: branch refs of `acme/app` on a fake GitHub
// that answer the ref read and the ref delete. It holds no tests of its own.
import type { FakeGitHub } from "../github/fake-github.test.ts";

export interface FakeBranches {
  /** The branches whose ref exists. */
  live: Set<string>;
  /** The branches deleted, in order. */
  deleted: string[];
}

/** Gives `github` a ref for each of `names`; any other ref is absent (404). */
export function fakeBranches(github: FakeGitHub, names: readonly string[]): FakeBranches {
  const branches: FakeBranches = { live: new Set(names), deleted: [] };
  for (const name of names) {
    github.routes.set(`GET /repos/acme/app/git/ref/heads/${name}`, () =>
      branches.live.has(name)
        ? { data: { ref: `refs/heads/${name}` } }
        : { status: 404, data: { message: "Not Found" } },
    );
    github.routes.set(`DELETE /repos/acme/app/git/refs/heads/${name}`, () => {
      branches.live.delete(name);
      branches.deleted.push(name);
      return { status: 204 };
    });
  }
  return branches;
}
