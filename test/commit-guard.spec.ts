import { findCommitProblems, isGitCommit } from '../.claude/hooks/commit-guard.mjs';

const noFiles = { stagedFiles: [], readFile: () => undefined };

describe('commit guard hook', () => {
  it('recognizes git commit commands, also in a chain', () => {
    expect(isGitCommit('git commit -m "Add order endpoint"')).toBe(true);
    expect(isGitCommit('git add . && rtk git commit -m "x"')).toBe(true);
    expect(isGitCommit('git status')).toBe(false);
    expect(isGitCommit('npm test')).toBe(false);
  });

  it('allows a plain commit message', () => {
    expect(findCommitProblems('git commit -m "Add order endpoint"', noFiles)).toEqual([]);
  });

  it.each([
    'git commit -m "Add endpoint (written with Claude)"',
    'git commit -m "Add endpoint" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
    "git commit -m \"$(cat <<'EOF'\nAdd endpoint\n\nGenerated with claude code\nEOF\n)\"",
  ])('blocks a message that mentions the assistant: %s', (command) => {
    expect(findCommitProblems(command, noFiles)).toHaveLength(1);
  });

  it('checks a message file passed with -F', () => {
    const readFile = (path: string) => (path === 'msg.txt' ? 'Fix bug\n\nAssisted-by: Claude' : undefined);
    expect(findCommitProblems('git commit -F msg.txt', { stagedFiles: [], readFile })).toHaveLength(1);
  });

  it('allows the project file names CLAUDE.md and .claude/', () => {
    const command = 'git add CLAUDE.md .claude/settings.json && git commit -m "Update project rules"';
    expect(findCommitProblems(command, noFiles)).toEqual([]);
  });

  it.each([['.env'], ['config/.env'], ['.env.local']])('blocks a staged secret file: %s', (file) => {
    const problems = findCommitProblems('git commit -m "Update config"', {
      stagedFiles: [file],
      readFile: () => undefined,
    });
    expect(problems).toHaveLength(1);
  });

  it('blocks a .env file added in the same command', () => {
    expect(findCommitProblems('git add -f .env && git commit -m "x"', noFiles)).toHaveLength(1);
  });

  it('allows .env.example', () => {
    const context = { stagedFiles: ['.env.example'], readFile: () => undefined };
    expect(findCommitProblems('git add .env.example && git commit -m "Add variable"', context)).toEqual([]);
  });
});
