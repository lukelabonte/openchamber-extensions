# Captain's orders

The captain's standing orders live here. They outrank the charter except its hard rules. Leave empty when there are none.

## Landing cleanup

After a task lands, or when cleanup is explicitly authorized, FirstMate can dispatch a cleanup worker using the installed cleanup runbook. Repository mutations stay with that worker. Review the saved report and backlog for every implementation and landing worker worktree and branch. Confirm the exact PR is merged (or the approved local commit landed), the worktree is clean including ignored files, and no active session or other task still needs it. Graceful per-location release of verified idle, task-owned tooling is included in that cleanup scope; it doesn't need another approval. Move the worker and its cwd outside all targets first. Run any project-specific simulator or tool teardown before non-forced removal:

    git worktree remove <worktree-path>
    git branch -d <fm/branch>

If removal fails, stop and inspect the reason. A squash or rebase merge can leave `git branch -d` reporting an unmerged branch even though the PR is merged. That warning alone doesn't prove either safety or failure. Retain and report the branch; this workflow never force-deletes it. Remote branch deletion is separate and requires existing explicit authorization. Unknown activity, handles, runtime identities or dirty/unlanded content block cleanup. No process signals, shared-service restarts, active-session interruption or permission-policy changes are part of the workflow.

FirstMate archives finished worker sessions and removes eligible merged PR links from its coordinator. Those operations preserve conversations, saved evidence, branches, and worktrees. Keep task reports and backlog PR URLs as history after repository cleanup.
