# Objectives

- After an update, rebuild. This will ensure your hex files are up-to-date.
- Before a push, run fmt, clippy, and the fast tests

# Use

- ```bash git config --local core.hooksPath .githooks/```

# Notes:

- "Before Git invokes a hook, it changes its working directory to either $GIT_DIR in a bare repository or the root of the working tree in a non-bare repository"
  https://git-scm.com/docs/githooks

