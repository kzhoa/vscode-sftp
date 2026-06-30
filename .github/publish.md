Publish Pipeline

Branch Roles

- Treat `origin/dev` as the only source of truth for ongoing development and the next release candidate.
- Treat `main` as released history only.
- Do not commit feature, fix, or refactor changes directly to `main`.
- Treat local `dev` as a working copy of `origin/dev`.
- Push local `dev` to `origin/dev` before starting the release flow if local `dev` is ahead.

Release Flow

- Ensure the working tree is clean. If there are uncommitted changes, commit them before continuing.
- If the current branch is not `dev`, switch to `dev`.
- If local `dev` is ahead of `origin/dev`, push `dev` to `origin/dev` before continuing.
- Review the commits that exist on `dev` but not on `main`, and stop if any commit should not be included in this release.
- Review the commits that exist on `main` but not on `dev`, and stop if `main` contains unexpected development changes.
- Run `npm run preflight` on `dev`.
- Rebase `dev` onto `main` before the release merge.
- Switch to `main`.
- Merge `dev` into `main`.
- Modify the `version` field in `package.json`.
- Finalize the `## X.X.X - {yyyy}-{mm}-{dd}` or `## vX.X.X - {yyyy}-{mm}-{dd}` section in `CHANGELOG.md`.
  - The GitHub Release body is extracted from the changelog section matching the pushed tag.
- Commit the version and changelog modifications on `main` using the message `release vX.X.X`.
- Create the tag `vX.X.X`.
- Push `main` and the version tag.
- Switch back to `dev`.
- Merge `main` back into `dev` so the release commit is preserved for the next development cycle.
- Stop and investigate before pushing if merging `main` back into `dev` is not clean.
- Push `dev` to `origin/dev`.
- Leave the local checkout on `dev`.

Branch Safety Rules

- Advance `main` only through release merges from `dev` plus the release commit that updates version and changelog.
- Do not release from a local-only `dev` state that has not been pushed to `origin/dev`.
- Stop and investigate before pushing `origin/dev` if `main -> dev` cannot be merged cleanly after release.
- Synchronize every release commit created on `main` back into `dev`.
