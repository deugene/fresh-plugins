---
name: commit
description: Conventional commit of staged changes; `pr` also pushes and opens a pull request
argument-hint: "[main] [pr] [hint]"
disable-model-invocation: true
allowed-tools: Bash(git switch -c *), Bash(git commit *), Bash(git push -u origin HEAD), Bash(gh pr create *), Bash(gh pr edit *)
---

## Context

!`git status --short --branch`

!`git diff --cached`

Arguments: $ARGUMENTS. A leading `main` commits on `main` itself; `pr` adds steps 3–4; the rest hints at the message or branch name.

## Steps

1. On `main`: if the arguments start with `main`, commit there; otherwise `git switch -c` a branch named like recent `origin/` branches.
2. Commit only what is staged. Nothing staged: list the changed files and stop. Clean tree: skip.
   Message `type(scope): subject`, imperative, subject ≤50 chars. Scope: the Jira key in the branch name, uppercased (`…-hl-9845-…` → `HL-9845`); else a module name, or none.
3. `git push -u origin HEAD`.
4. PR for the branch already open: `gh pr edit` its title and body to match all of `origin/main..HEAD`. Otherwise `gh pr create`: title in the commit format, ≤70 chars; body `## Summary` (1–3 bullets covering all of `origin/main..HEAD`) and `## Test plan` (checklist).
