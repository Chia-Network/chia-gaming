import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';
import * as bls_loader from 'bls-signatures';
const {h, t, Program, compile} = require('../../../clvm_tools_rs/wasm/pkg/clvm_tools_wasm');
import {Hand} from 'pokersolver';

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

    rank(): number {
        return (this.value / 4) + 1;
    }

    suit(): number {
        return (this.value % 4) + 1;
    }

    toString(): string {
        const rank = this.value / 4;
        const suit = this.value % 4;
        return "A23456789TJQK".charAt(rank) + "hdcs".charAt(suit);
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
    // Make some cards
    const deck = new CardDeck(99, 3, 17);
    const cards = deck.deal(7);
    assert.equal(cards.join(','), '5d,5c,6d,Tc,9h,5h,3s');

    // Load program.
    const run_handcalc_hex = fs.readFileSync('clvm-hex/run_handcalc.hex', 'utf8');
    const run_handcalc = Program.from_hex(run_handcalc_hex);
    const run_onehandcalc_hex = fs.readFileSync('clvm-hex/run_onehandcalc.hex', 'utf8');
    const run_onehandcalc = Program.from_hex(run_onehandcalc_hex);

    function cards_from_bitmap(cards, bitmap) {
        const chosen_cards = [];
        for (var idx = 0; idx < cards.length; idx++) {
            if (bitmap & (1 << idx)) {
                chosen_cards.push(cards[idx]);
            }
        }
        return chosen_cards;
    };

    // Form argument to handcalc.
    const cards_clvm = Program.to([cards.map((c) => t(c.rank(), c.suit()))]);
    let chosen_cards = [];
    try {
        // Run handcalc.  The result is a bitmap on the cards.
        const [cost, result] = run_handcalc.run(cards_clvm);
        chosen_cards = cards_from_bitmap(cards, result.as_int());
    } catch (e) {
        console.error(e.toString());
        assert.equal(e, null);
    }

    // Three of a kind hand.
    const test_cards_clvm = Program.to([chosen_cards.map((c) => t(c.rank(), c.suit()))]);

    let hand_type = null;
    try {
        // Run onehandcalc.  The result is a description of a hand.
        const [cost, result] = run_onehandcalc.run(test_cards_clvm);
        hand_type = result.as_javascript();
    } catch (e) {
        console.error(e.toString());
        assert.equal(e, null);
    }

    // Show it's a 3 of a kind hand.
    assert.equal(hand_type[0], 3);
    assert.equal(hand_type[1], 1);
    assert.equal(hand_type[2], 1);

    // Show the card.
    assert.equal(hand_type[3], 5);

    const poker_hand = Hand.solve(cards.map((c) => c.toString()));
    assert.equal(poker_hand.descr, "Three of a Kind, 5's");
});
