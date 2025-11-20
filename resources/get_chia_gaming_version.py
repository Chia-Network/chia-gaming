#!/usr/bin/env python

import toml
t = toml.loads(open('Cargo.toml').read())
print(t['package']['version'])
