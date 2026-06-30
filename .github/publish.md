Publish Pipeline

- Run `npm run preflight`
- Ensure the working tree is clean; If there are uncommitted changes, commit them before continuing;
- If the current branch is not `dev`, switch to the `dev` branch, sync with the remote, and merge all changes.
- Before tagging a release, merge `dev` into `main` and verify the release commit on `main`.
- Modify `version` number in `package.json`;
- Finalize the `## X.X.X - {yyyy}-{mm}-{dd}` or `## vX.X.X - {yyyy}-{mm}-{dd}` section in `CHANGELOG.md` (the GitHub Release body is extracted from the section matching the pushed tag);
- Commit the version and changelog modifications on the main branch, formatted in "release vX.X.X".
- Create a new tag `vX.X.X`;
- Push the `main` branch and the version tag;
