# Release Reconcile and Conflict Resolver Prompt

You are resolving merge/rebase conflicts between upstream OMP changes and our native personalization fork.

## Workflow
1. Use `workflowz` to organize your work.
2. Read the conflict markers in the target worktree.
3. Map upstream changes, understand new signatures or refactorings.
4. Apply the minimal necessary edits to preserve personalization invariants:
   - Personalization store and policy behavior
   - Extension hooks and prompt overrides
   - Managed skill lifecycle and identity preservation
   - Coalesced Auto-Learn reflection
5. Run narrow tests to verify resolutions.
