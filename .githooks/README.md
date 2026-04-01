# Objectives

- Enforce filename portability checks at commit time.
- Run build and test commands manually via `./cb.sh` and `./ct.sh`.

# Use

- ```bash git config --local core.hooksPath .githooks/```

# Notes:

- "Before Git invokes a hook, it changes its working directory to either $GIT_DIR in a bare repository or the root of the working tree in a non-bare repository"
  https://git-scm.com/docs/githooks

- To commit without the pre-commit hook running, use `git commit --no-verify`
