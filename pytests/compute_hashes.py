from load_clvm import load_clvm
import sys
from pathlib import Path

# TODO: clsp / hex

#if len(sys.argv) <= 1:
#    print(f"Usage: {sys.argv[0]} prog.clsp")
#    sys.exit(1)

#dir = sys.argv[1]

validator_paths = Path("/Users/aqk/chia-gaming/clsp/onchain/calpoker/").glob("?.clsp")
validator_paths = sorted(list(validator_paths))
print(validator_paths)

output = """
program_hashes_hex = [
"""

for filename in validator_paths:
    program = load_clvm(filename, recompile=False)
    program_treehash = program.get_tree_hash()
    output += f"    '{program_treehash}',\n"

output += """
]
"""

with open("validator_hashes.py", "w") as f:
    f.write(output)
