Publish Pipeline

- Run `npm run preflight`
- Ensure the working tree is clean; If there are uncommitted changes, commit them before continuing;
- If the current branch is not `main`, switch to the `main` branch, sync with the remote, and merge all changes.
- Modify `version` number in `package.json`;
- Finalize the `## vX.X.X - {yyyy}-{mm}-{dd}` section in `CHANGELOG.md` (the GitHub Release body is extracted from this section);
- Commit the version and changelog modifications on the main branch, formatted in "release vX.X.X".
- Create a new tag `vX.X.X`;
- Push the `main` branch and the version tag;
