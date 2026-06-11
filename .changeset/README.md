# Changesets

Add a changeset for every package change that should appear in npm releases and changelogs:

```sh
pnpm changeset
```

Use:

- `patch` for fixes and small compatible improvements.
- `minor` for new compatible features.
- `major` for breaking changes.

Release flow:

1. Merge feature PRs into `dev`.
2. Open a release PR from `dev` to `main`.
3. Merging into `main` lets GitHub Actions open/update the `Version Packages` PR against `main`.
4. Merging `Version Packages` publishes to npm and creates GitHub releases.
