import hashlib

from hsms.streamables.program import Program
from hsms.puzzles.load_clvm import load_clvm

from clvm.EvalError import EvalError


MOD_A = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsa.clvm.hex").read()))
MOD_B = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsb.clvm.hex").read()))
MOD_C = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsc.clvm.hex").read()))
MOD_D = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsd.clvm.hex").read()))


def drun(prog: Program, *args: Program):
    try:
        return prog.run(*args)
    except EvalError as ee:
        print(f"brun -x -y main.sym {prog} {Program.to(list(args))}")
        raise

def sha256(blob:bytes) -> bytes:
    return hashlib.sha256(blob).digest()

def testrps(amove, bmove):
    total = 100
    alice_final = (total//2 if amove == bmove else (0 if bmove == (amove + 1) % 3 else total))
    alice_preimage = Program.to(60 + amove)
    bob_preimage = Program.to(60 + bmove)
    alice_image = sha256(alice_preimage.atom)
    bob_image = sha256(bob_preimage.atom)
    alice_move = Program.to(amove)

    cd = MOD_D.curry(alice_move, bob_image)
    assert cd.run([total, bob_preimage, b'', alice_final, b'j']).atom == b'j'
    cc = MOD_C.curry(alice_image, bob_image)
    assert cc.run([total, alice_preimage, cd.tree_hash(), 0, b'j']).atom == b'j'
    cb = MOD_B.curry(alice_image)
    assert cb.run([total, bob_image, cc.tree_hash(), 0, b'j']).atom == b'j'
    assert MOD_A.run([total, alice_image, cb.tree_hash(), 0, b'j']).atom == b'j'

def testall():
    for i in range(3):
        for j in range(3):
            testrps(i, j)

if __name__ == '__main__':
    testall()
