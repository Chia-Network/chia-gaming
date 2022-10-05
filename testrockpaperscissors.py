import hashlib

from hsms.streamables.program import Program
from hsms.puzzles.load_clvm import load_clvm

MOD_A = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsa.clvm.hex").read()))
MOD_B = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsb.clvm.hex").read()))
MOD_C = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsc.clvm.hex").read()))
MOD_D = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsd.clvm.hex").read()))

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
    assert cd.run([total, b'', alice_final, bob_preimage]).atom == b''
    cc = MOD_C.curry(alice_image, bob_image)
    assert cc.run([total, cd.tree_hash(), 0, alice_preimage]).atom == b''
    cb = MOD_B.curry(alice_image)
    assert cb.run([total, cc.tree_hash(), 0, bob_image]).atom == b''
    assert MOD_A.run([total, cb.tree_hash(), 0, alice_image]).atom == b''

def testall():
    for i in range(3):
        for j in range(3):
            testrps(i, j)

if __name__ == '__main__':
    testall()
