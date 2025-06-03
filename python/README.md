

## Install [uv](https://docs.astral.sh/uv)

```bash

# mac
brew install uv

# linux - installs into "$HOME/.local/bin"
curl -LsSf https://astral.sh/uv/install.sh | sudo sh

# windows, via [scoop](https://scoop.sh/#/apps?q=uv)
## Install scoop
powershell Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
## install uv
scoop bucket add main
scoop install main/uv

# windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

## virtual env

```bash
uv venv
source .venv/bin/activate
```

## Working in the Python virtual environment

```bash
cd ~/chia-gaming/python/tests
uv run test_calpoker_handlers.py
```

## Run linters and other tools

```bash
uvx black file.py
```

## Useful references

[A comprehensive uv overview](https://www.datacamp.com/tutorial/python-uv)

[uv official reference](https://docs.astral.sh/uv/reference/)
