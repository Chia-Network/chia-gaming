import * as process from 'process';
import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
const {compile, get_dependencies} = require('../clvm_tools_rs/wasm/pkg/clvm_tools_wasm');

function collect<A>(value: A, previous: Array<A>): Array<A> {
    return previous.concat([value]);
}

function get_file_date(filename: string): number|undefined {
    try {
        let stat = fs.lstatSync(filename);
        return stat.mtimeMs;
    } catch (e) {
        return undefined;
    }
}

const compiler_options = {
    "log": (msg: string) => {
        console.warn(msg);
    },
    "read_new_file": (filename: string, dirs: Array<string>) => {
        for (let d in dirs) {
            let dir = dirs[d];
            let read_path = path.resolve(dir, filename);
            try {
                return [read_path, fs.readFileSync(read_path, 'utf8')];
            } catch (e) {
                // Ok, try the next dir.
            }
        }

        throw `Could not find file ${filename}`;
    }
};

program
    .description('simple chialisp compiler interface')
    .argument('<chialisp program>', 'program to compile')
    .option('-s, --symbols <output sym file>', 'symbol file')
    .option('-o, --output <output hex file>', 'hex output')
    .option('-N, --no-check-dependencies')
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

let symbol_file = opts.symbols;
if (!symbol_file) {
    symbol_file = path.format({ ...path.parse(opts.output), base: '', ext: '.sym' });
}

try {
    let outputIsNewer = false;
    if (opts.checkDependencies) {
        let dependencies = get_dependencies(
            input_program,
            input_file,
            opts.include,
            compiler_options
        );

        if (dependencies.error) {
            console.error(dependencies.error);
            process.exit(1);
        }

        let outputTime = get_file_date(opts.output);
        if (outputTime) {
            outputIsNewer = get_file_date(input_file) < outputTime;

            for (let d in dependencies) {
                const dep = dependencies[d];
                if (get_file_date(dep) > outputTime) {
                    outputIsNewer = false;
                }
            }
        } else {
            outputIsNewer = false;
        }
    }

    if (!outputIsNewer) {
        let program_output = compile(
            input_program,
            input_file,
            opts.include,
            compiler_options
        );

        if (program_output.error) {
            console.error(program_output.error);
            process.exit(1);
        }

        fs.writeFileSync(opts.output, program_output.hex);
        fs.writeFileSync(symbol_file, JSON.stringify(program_output.symbols));
    }
} catch (e) {
    console.error(e);
    process.exit(1);
}
