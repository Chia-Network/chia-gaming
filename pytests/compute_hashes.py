import os
import sys
from pathlib import Path

from load_clvm_hex import load_clvm_hex

# TODO: clsp / hex

#if len(sys.argv) <= 1:
#    print(f"Usage: {sys.argv[0]} prog.clsp")
#    sys.exit(1)

#dir = sys.argv[1]

my_path = path = os.path.dirname(__file__)
validator_paths = (Path(my_path) / "../clsp/onchain/calpoker/").glob("?.hex")
validator_paths = sorted(list(validator_paths))

output = """
program_hashes_hex = [
"""

for filename in validator_paths:
    program = load_clvm_hex(filename)
    program_treehash = program.get_tree_hash()
    output += f"    '{program_treehash}',\n"

output += """
]
"""

with open("validator_hashes.py", "w") as f:
    f.write(output)
