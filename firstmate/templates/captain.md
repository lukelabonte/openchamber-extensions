# Captain's orders

The captain's standing orders live here. They outrank the charter except its hard rules. Leave empty when there are none.

## Landing cleanup

After a task lands, review its saved report and backlog for every implementation and landing worker worktree and branch. Confirm the exact PR is merged (or the approved local commit landed), the worktree is clean, and no active session or other task still needs it. Run any project-specific simulator or tool teardown before removal. Then remove the confirmed disposable worktree and local branch:

    git worktree remove <worktree-path>
    git branch -d <fm/branch>

If removal fails, stop and inspect the reason. A squash or rebase merge can leave `git branch -d` reporting an unmerged branch even though the PR is merged. That warning alone doesn't prove either safety or failure. Any force deletion needs separate approval for that exact work. Remote branch deletion is separate too.

FirstMate archives finished worker sessions and removes eligible merged PR links from its coordinator. Those operations preserve conversations, saved evidence, branches, and worktrees. Keep task reports and backlog PR URLs as history after repository cleanup.
