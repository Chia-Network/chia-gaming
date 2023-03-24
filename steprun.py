import os
from pathlib import Path
import binascii
import json
from clvm_tools.binutils import assemble, disassemble
from clvm_tools_rs import start_clvm_program, compose_run_function, compile_clvm
from chia.types.blockchain_format.program import Program

def compile_module_with_symbols(include_paths,source):
    path_obj = Path(source)
    file_path = path_obj.parent
    file_stem = path_obj.stem
    target_file = file_path / (file_stem + ".clvm.hex")
    sym_file = file_path / (file_stem + ".sym")
    compile_result = compile_clvm(source, str(target_file.absolute()), include_paths, True)
    symbols = compile_result['symbols']
    if len(symbols) != 0:
        with open(str(sym_file.absolute()),'w') as symfile:
            symfile.write(json.dumps(symbols))

def run_until_end(p):
    last = None
    location = None

    while not p.is_ended():
        step_result = p.step()
        if step_result is not None:
            last = step_result
            if 'Result-Location' in last and \
               'Arguments' in last and \
               'print' in last['Result-Location'] and \
               'Value' in last:
                value_assembled = assemble(last['Value'])
                assembled_arg_list = []
                while value_assembled.pair is not None:
                    assembled_arg_list.append(value_assembled.pair[0])
                    value_assembled = value_assembled.pair[1]
                if len(assembled_arg_list) > 2:
                    to_show = disassemble(Program.to(assembled_arg_list[-2:]))
                    print(f"print {last['Operator']} {to_show}")

    return last

def diag_run_clvm(program, args, symbols):
    hex_form_of_program = binascii.hexlify(bytes(program)).decode('utf8')
    hex_form_of_args = binascii.hexlify(bytes(args)).decode('utf8')
    symbols = json.loads(open(symbols).read())
    p = start_clvm_program(hex_form_of_program, hex_form_of_args, symbols)
    report = run_until_end(p)
    if 'Failure' in report:
        raise Exception(report)
    else:
        return assemble(report['Final'])

if __name__ == '__main__':
    # smoke test
    import sys
    program = Program.fromhex(open(sys.argv[1]).read())
    args = Program.fromhex(open(sys.argv[2]).read())
    diag_run_clvm(program, args)

