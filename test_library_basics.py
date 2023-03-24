import pytest
import random
from itertools import permutations
from hsms.streamables.program import Program
from steprun import diag_run_clvm, compile_module_with_symbols

compile_module_with_symbols(['.'], 'smoke_test_deep_compare.clsp')
compare_program = Program.from_bytes(bytes.fromhex(open('smoke_test_deep_compare.clvm.hex').read()))

compile_module_with_symbols(['.'], 'smoke_test_sort.clsp')
sort_program = Program.from_bytes(bytes.fromhex(open('smoke_test_sort.clvm.hex').read()))

compile_module_with_symbols(['.'], 'test_sort.clsp')
test_sort_program = Program.from_bytes(bytes.fromhex(open('test_sort.clvm.hex').read()))

compile_module_with_symbols(['.'], 'test_reverse.clsp')
test_reverse_program = Program.from_bytes(bytes.fromhex(open('test_reverse.clvm.hex').read()))

compile_module_with_symbols(['.'], 'test_prepend.clsp')
test_prepend_program = Program.from_bytes(bytes.fromhex(open('test_prepend.clvm.hex').read()))

compile_module_with_symbols(['.'], 'test_range.clsp')
test_range_program = Program.from_bytes(bytes.fromhex(open('test_range.clvm.hex').read()))

compile_module_with_symbols(['.'], 'test_permutations.clsp')
test_permutations_program = Program.from_bytes(bytes.fromhex(open('test_permutations.clvm.hex').read()))

def proper_list_inner(result,cl):
    if hasattr(cl, 'pair') and cl.pair is not None:
        result.append(cl.pair[0])
        return proper_list_inner(result,cl.pair[1])
    else:
        return result

def proper_list(cl):
    result = []
    return proper_list_inner(result,cl)

def int_list(cl):
    return [Program.to(x).as_int() for x in Program.to(cl).as_atom_list()]

def de_none_list(l):
    return [x if x is not None else [] for x in l]

def with_random_lists(n,f):
    for length in range(n): # 0-10 length
        for i in range(1 + (3 * length)): # A few orders each
            orig_list = [random.randint(0,100) for x in range(length)]
            f(orig_list)

def test_smoke_compare():
    compare_program.run(Program.to([]))

def test_prepend():
    for length1 in range(5):
        list_1 = list(range(length1))
        for length2 in range(length1):
            prepend_result = test_prepend_program.run([Program.to(list_1[:length2]),Program.to(list_1[length2:])])
            assert list_1 == int_list(prepend_result)

def test_reverse():
    def test_reverse_list(l):
        rev_args = Program.to([l])
        reversed_result = Program.to(list(reversed(l)))
        reversed_by_prog = test_reverse_program.run(rev_args)
        assert reversed_result == reversed_by_prog

    with_random_lists(10,test_reverse_list)

def test_range():
    for length in range(10):
        want_list = list(range(length))
        result = test_range_program.run(Program.to([length]))
        assert want_list == result

def do_test_permutations_of_size_n(n):
    try_list = [random.randint(0,100) for x in range(n)]
    want_set = list([list(v) for v in sorted(permutations(try_list))])
    print('try_list', try_list)
    if n == 2:
        listed_result = diag_run_clvm(test_permutations_program, Program.to([try_list]), 'test_permutations.sym')
    else:
        listed_result = test_permutations_program.run(Program.to([try_list]))
    pl = proper_list(listed_result)
    perms_result = sorted([int_list(x) for x in de_none_list(pl)])
    print('got_back', perms_result, 'but_wanted', want_set)
    assert want_set == perms_result

def test_permutations_0():
    do_test_permutations_of_size_n(0)

# def test_permutations_1():
#     do_test_permutations_of_size_n(1)

def test_permutations_2():
    n = 2
    try_list = ['aaaaaa','bbbbbb']
    want_set = list([list(v) for v in sorted(permutations(try_list))])
    if n == 2:
        listed_result = diag_run_clvm(test_permutations_program, Program.to([try_list]), 'test_permutations.sym')
    else:
        listed_result = test_permutations_program.run(Program.to([try_list]))
    pl = proper_list(listed_result)
    perms_result = sorted([int_list(x) for x in de_none_list(pl)])
    print('got_back', perms_result, 'but_wanted', want_set)
    assert want_set == perms_result

# def test_chialisp_sort_program():
#     test_sort_program.run(Program.to([]))

def test_smoke_sort():
    for length in range(10): # 0-10 length
        for i in range(1 + (3 * length)): # A few orders each
            orig_list = [random.randint(0,100) for x in range(length)]
            sort_args = Program.to([orig_list])
            sorted_list = Program.to(sorted(orig_list))
            print(orig_list)
            sort_res = sort_program.run(sort_args)
            print(sort_res,sorted_list)
            assert sort_res == sorted_list

if __name__ == '__main__':
    test_smoke_sort()
