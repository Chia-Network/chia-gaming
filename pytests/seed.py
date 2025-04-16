from hashlib import sha256
from clvm_types.program import Program

class GameSeed:
    def __init__(self, int_seed):
        self.alice_seed = sha256(("alice" + str(int_seed)).encode("utf8")).digest()[:16]
        self.bob_seed = sha256(("bob" + str(int_seed)).encode("utf8")).digest()[:16]
        self.seed = sha256(self.alice_seed + self.bob_seed + bytes(Program.to(200))[1:]).digest()
