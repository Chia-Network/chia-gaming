import { program } from 'commander';
import * as fs from 'fs';
const {compile} = require('../clvm_tools_rs/wasm/pkg/clvm_tools_wasm');

program
    .description('simple chialisp compiler interface')
    .argument('<string>', 'program to compile')
    .option('--output', 'hex output')
    .option('-i', 'add search path');

program.parse();

console.log('Options:', program.opts());
console.log('Arguments:', program.args);
