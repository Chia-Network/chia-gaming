"""Pytest configuration for tools/ tests."""

from __future__ import annotations

import pytest


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "full_build: run slow cargo-build tests")


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--full-build",
        action="store_true",
        default=False,
        help="Run slow full-build tests that invoke cargo build",
    )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    if config.getoption("--full-build"):
        return
    skip = pytest.mark.skip(reason="needs --full-build option to run")
    for item in items:
        if "full_build" in item.keywords:
            item.add_marker(skip)
