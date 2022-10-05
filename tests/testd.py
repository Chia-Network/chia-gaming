import hashlib

from hsms.streamables.program import Program
from hsms.puzzles.load_clvm import load_clvm

MOD_D = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsd.clvm.hex").read()))


def sha256(blob:bytes) -> bytes:
    return hashlib.sha256(blob).digest()


def winner(m1, m2) -> int:
    return (m1 - m2) % 3


def test_winner():
    # (alice_move bob_image total new_validation alice_share bob_preimage)
    total = 2
    new_validation = 0
    for alice_move in range(3):
        for bob_move in range(3):
            w = winner(alice_move, bob_move)
            if w == 2:
                alice_share = total
            elif w == 0:
                alice_share = total >> 1
            else:
                alice_share = 0
            bob_preimage = bytes([0x30, bob_move])
            bob_image = sha256(bob_preimage)
            solution = Program.to([alice_move, bob_image, total, new_validation, alice_share, bob_preimage])
            print(MOD_D)
            print(solution)
            r = MOD_D.run(solution)
            assert r == Program.to(0)
