import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';
import * as bls_loader from 'bls-signatures';
const {h, t, Program, compile} = require('../../../clvm_tools_rs/wasm/pkg/clvm_tools_wasm');

it('can compile clvm', async () => {
    const program_output = compile(
        fs.readFileSync('test-content/t1.clsp', 'utf8'),
        't1.clsp',
        ['test-content'],
        {
            "read_new_file": (filename: string, dirs: Array<string>) => {
                for (let d in dirs) {
                    let dir = dirs[d];
                    let path = resolve(dir, filename);
                    try {
                        return [path, fs.readFileSync(path, 'utf8')];
                    } catch (e) {
                        // Ok, try the next dir.
                    }
                }

                throw `Could not find file ${filename}`;
            }
        }
    );
    assert.equal(program_output.hex, 'ff10ff02ffff010180');
});

class Card {
    value: number

    constructor(value: number) {
        this.value = value;
    }

    toString(): string {
        const rank = this.value / 4;
        const suit = this.value % 4;
        return "HDCS".charAt(suit) + "A23456789TJQK".charAt(rank);
    }
}

class CardDeck {
    deck: [Card];
    a: number;
    b: number;
    c: number;

    constructor(a: number, b: number, c: number) {
        this.deck = [... Array(52)].map((_, i) => new Card(i));
        this.a = a;
        this.b = b;
        this.c = c;
    }

    deal(n: number): [Card] {
        let out_deck = [];
        for (let i = 0; this.deck.length > 0 && i < n; i++) {
            const use_index = (this.a * (i * i) + this.b * i + this.c) % this.deck.length;
            const use_card = this.deck[use_index];
            out_deck.push(use_card);
            this.deck.splice(use_index, 1);
        }
        return out_deck;
    }
}

it('can try playing poker hands', async () => {
    const deck = new CardDeck(99, 3, 17);
    const cards = deck.deal(7);
    assert.equal(cards.join(','), 'D5,C5,D6,CT,H9,H5,S3');
});
