// Types for commit-guard.mjs, so the TypeScript tests can import it under `strict`.

/**
 * Tells whether a shell command runs `git commit` (also inside a chain such as `git add . && git commit`).
 */
export function isGitCommit(command: string): boolean;

/**
 * Lists the reasons a `git commit` command must be blocked, without running any checks.
 */
export function findCommitProblems(
  command: string,
  context: { stagedFiles: string[]; readFile: (path: string) => string | undefined },
): string[];
