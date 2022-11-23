import hashlib

from hsms.streamables.program import Program

from clvm.EvalError import EvalError

noncegame = Program.from_bytes(bytes.fromhex(open("noncegame.clvm.hex").read()))
noncehash = noncegame.tree_hash()

def drun(prog: Program, args: Program):
    try:
        return prog.run(args)
    except EvalError as ee:
        print(f"brun -x -y main.sym {prog} {Program.to(args)}")
        raise

def testnonce(startnonce, maxnonce):
    for i in range(startnonce, maxnonce):
        mygame = noncegame.curry(i, noncehash)
        good_parameters = [i*2, noncegame.curry(i+1, noncehash).tree_hash(), 1, (i*4, b'g')]
        bad_parameters = [i*3, noncegame.curry(i+2, noncehash).tree_hash(), 2, (i*5, b'g')]
        assert drun(mygame, good_parameters) == b'g'
        for j in range(len(good_parameters)):
            try:
                p = list(good_parameters)
                p[j] = bad_parameters[j]
                mygame.run(p)
                assert False
            except EvalError as ee:
                pass

if __name__ == '__main__':
    testnonce(3, 7)
