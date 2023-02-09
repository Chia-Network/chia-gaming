import os
import binascii
import json
from clvm_tools_rs import start_clvm_program, compose_run_function
from chia.types.blockchain_format.program import Program

def run_until_end(p):
    last = None
    location = None

    while not p.is_ended():
        step_result = p.step()
        if step_result is not None:
            last = step_result
            if 'Operator-Location' in last:
                if 'referee.clsp(23)' in last['Operator-Location'] and 'Arguments' in last:
                    print(f"print {last['Arguments']}\n")

    return last

def diag_run_clvm(program, args, symbols):
    hex_form_of_program = binascii.hexlify(bytes(program)).decode('utf8')
    hex_form_of_args = binascii.hexlify(bytes(args)).decode('utf8')
    symbols = json.loads(open(symbols).read())
    p = start_clvm_program(hex_form_of_program, hex_form_of_args, symbols)
    report = run_until_end(p)
    print(report)

if __name__ == '__main__':
    # smoke test
    import sys
    program = Program.fromhex(open(sys.argv[1]).read())
    args = Program.fromhex(open(sys.argv[2]).read())
    diag_run_clvm(program, args)

