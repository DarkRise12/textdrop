# Maintainer release procedure

1. Update `CHANGELOG.md`, the default image in `compose.selfhost.yaml` and
   `deploy/selfhost.env.example`, and the versioned examples in README/install docs.
2. Run Python/JavaScript tests. Push the reviewed commit to master and wait for CI.
3. Tag that exact commit with an unused `vMAJOR.MINOR.PATCH` and push the tag.
   The tag workflow reruns checks, builds Linux AMD64/ARM64, tests each candidate
   container, and only then promotes the version and `latest` image tags.
4. On the first release, make the `textdrop` GHCR package public in its package
   settings. Repository visibility alone does not make a package public. Verify
   an anonymous pull; never advertise an image requiring your credentials.
5. Assemble the install bundle with `python3 deploy/package-release.py VERSION OUT`.
   This contains configuration, setup/backup helpers, install documentation and
   license, never runtime data or credentials. Attach its archive and SHA256SUMS
   to a GitHub release for the tested tag. Do not move published version tags.
6. Smoke-test the downloaded bundle, install, login, persistence and backups on a
   clean machine. Confirm the public production site if master changed its image.

Source: [GitHub container package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

Production deployment still uses the existing restricted SSH workflow only for
master. The public image workflow has no production secrets or SSH access.
