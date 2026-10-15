// Claude Code PreToolUse hook (see .claude/settings.json). Runs before every Bash or PowerShell
// command Claude Code wants to execute. For `git commit` commands it enforces three rules from
// CLAUDE.md that must hold every time, not just when the assistant remembers them:
//   1. the commit message never mentions the AI assistant (no names, no attribution lines);
//   2. no .env file (other than .env.example) is committed;
//   3. lint, type check and unit tests pass.
// Exit code 2 blocks the command; stderr is shown to the assistant as the reason.
// Commits made by a person in their own terminal don't go through this hook.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT_COMMIT = /\bgit\s+(?:-\S+\s+)*commit\b/;
const FORBIDDEN_WORDS = /claude|anthropic/i;
// File names the project legitimately mentions: CLAUDE.md, CLAUDE.local.md and the .claude/ folder.
const ALLOWED_NAMES = [/\bCLAUDE(?:\.local)?\.md\b/gi, /\S*\.claude[\\/]\S*/gi];
const MESSAGE_FILE = /(?:^|\s)(?:-F|--file)(?:=|\s+)("[^"]+"|'[^']+'|\S+)/;
const SECRET_ENV_FILE = /(?:^|[\\/])\.env(?:\.(?!example$)[^\\/]+)?$/;
const CHECKS = 'npm run lint && npm run typecheck && npm test';

/**
 * Tells whether a shell command runs `git commit` (also inside a chain such as `git add . && git commit`).
 * @param {string} command The command text from the hook input.
 * @returns {boolean}
 */
export function isGitCommit(command) {
  return GIT_COMMIT.test(command);
}

/**
 * Lists the reasons a `git commit` command must be blocked, without running any checks.
 * The whole command is scanned, so messages given with -m, a heredoc or -F are all covered.
 * @param {string} command The command text from the hook input.
 * @param {{ stagedFiles: string[], readFile: (path: string) => string | undefined }} context
 *   Files already staged, and a reader for a message file passed with -F (undefined if missing).
 * @returns {string[]} One sentence per problem; empty when the commit may go ahead.
 */
export function findCommitProblems(command, { stagedFiles, readFile }) {
  const problems = [];

  let text = command;
  const messageFile = MESSAGE_FILE.exec(command)?.[1].replace(/^["']|["']$/g, '');
  if (messageFile) text += '\n' + (readFile(messageFile) ?? '');
  for (const name of ALLOWED_NAMES) text = text.replace(name, '');
  if (FORBIDDEN_WORDS.test(text)) {
    problems.push(
      'The commit message mentions Claude or Anthropic. Commit messages must not name the AI ' +
        'assistant or include attribution or Co-Authored-By lines.',
    );
  }

  const envFiles = [...stagedFiles, ...command.split(/[\s"';&|]+/)].filter((f) =>
    SECRET_ENV_FILE.test(f),
  );
  if (envFiles.length > 0) {
    problems.push(
      `The commit would include ${[...new Set(envFiles)].join(', ')}. Only .env.example may be ` +
        'committed; .env files hold secrets.',
    );
  }

  return problems;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function stagedFiles(cwd) {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runChecks(cwd) {
  try {
    execSync(CHECKS, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return undefined;
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim().split('\n');
    return output.slice(-40).join('\n');
  }
}

function main() {
  const input = JSON.parse(readStdin());
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !isGitCommit(command)) return 0;

  const cwd = input.cwd ?? process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;
  const problems = findCommitProblems(command, {
    stagedFiles: stagedFiles(cwd),
    readFile: (path) => {
      const full = resolve(cwd, path);
      return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    },
  });
  if (problems.length > 0) {
    process.stderr.write(`Commit blocked:\n- ${problems.join('\n- ')}\n`);
    return 2;
  }

  const failure = runChecks(projectDir);
  if (failure !== undefined) {
    process.stderr.write(`Commit blocked: \`${CHECKS}\` failed. Fix it, then commit again.\n${failure}\n`);
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
