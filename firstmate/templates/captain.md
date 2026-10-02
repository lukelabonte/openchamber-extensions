# Captain's orders

The captain's standing orders live here. They outrank the charter except its hard rules. Leave empty when there are none.

## Landing cleanup

After a task lands, remove its worktree and branch. The worktree path and branch are in that task's backlog entry:

    git worktree remove <worktree-path>
    git branch -d <fm/branch>

Use `git branch -D` only if git refuses because the branch is unmerged — that means the landing did not actually land, so check first.
