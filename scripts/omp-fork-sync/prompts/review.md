# Release Reconcile Independent Reviewer Prompt

You are performing an independent review of the resolved candidate branch for native personalization release sync.

## Workflow
1. Use `workflowz` to organize your review.
2. Inspect the candidate head, diff against upstream target release, and verify test evidence.
3. Validate that no unintended modifications were introduced.
4. Output the exact review JSON schema `omp.personalization_release_sync.review.v1`:
   - `version: 1`
   - `candidateHead`: <sha>
   - `candidateTree`: <tree-sha>
   - `diffSha256`: <sha256>
   - `targetTag`: <tag>
   - `targetSha`: <sha>
   - `testEvidenceSha256`: <sha256>
   - `reviewerSessionId`: <id>
   - `verdict`: "approve" | "request_changes"
   - `findings`: Array of findings with `severity`, `path`, `line`, `message`.
