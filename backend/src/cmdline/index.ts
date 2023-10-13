import * as process from 'process';
import { program } from 'commander';
import * as fs from 'fs';
import { resolve } from 'path';
const {compile} = require('../clvm_tools_rs/wasm/pkg/clvm_tools_wasm');

function collect<A>(value: A, previous: Array<A>): Array<A> {
    return previous.concat([value]);
}

program
    .description('simple chialisp compiler interface')
    .argument('<chialisp program>', 'program to compile')
    .option('-o, --output <output hex file>', 'hex output')
    .option('-i, --include <path ...>', 'add search path', collect, []);

program.parse();

const opts = program.opts();

if (program.args.length != 1) {
    console.error('must compile exactly one program');
    process.exit(1);
}

if (!opts.output) {
    console.error('must specify output hex file');
    process.exit(1);
}

const input_file = program.args[0];
let input_program;

try {
    input_program = fs.readFileSync(input_file, 'utf8');
} catch (e) {
    console.error(`could not read ${input_file}: ${e}`);
    process.exit(1);
}

try {
    let program_output = compile(
        input_program,
        input_file,
        opts.include,
        {
            "read_new_file": (filename: string, dirs: Array<string>) => {
                for (let d in dirs) {
                    let dir = dirs[d];
                    let path = resolve(dir, filename);
                    try {
                        return fs.readFileSync(path, 'utf8');
                    } catch (e) {
                        // Ok, try the next dir.
                    }
                }

                throw `Could not find file ${filename}`;
            }
        }
    );

    if (program_output.error) {
        console.error(program_output.error);
        process.exit(1);
    }

    fs.writeFileSync(opts.output, program_output.hex);
} catch (e) {
    console.error(e);
    process.exit(1);
}
