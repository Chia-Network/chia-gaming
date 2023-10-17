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

function intify(n) {
    return Number(n);
}

function string_of_rank(rank) {
    return " A23456789TJQK".charAt(intify(rank));
}

function poker_lib_string_of_rank(rank) {
    if (rank == 10) {
        return "10";
    } else {
        return string_of_rank(rank);
    }
}

function string_of_suit(suit) {
    return " hdcs".charAt(suit);
}

class Card {
    value: number

    constructor(value: number) {
        this.value = value;
    }

    rank(): number {
        return Math.floor((this.value / 4)) + 1;
    }

    suit(): number {
        return (this.value % 4) + 1;
    }

    toString(): string {
        const rank = this.value / 4;
        const suit = this.value % 4;
        return string_of_rank(rank + 1) + string_of_suit(suit + 1);
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

function use_ace_for_flush_if_needed(cards, top_rank) {
    // Straight flush
    let suits = [... Array(5)].map((_) => 0);
    cards.forEach((c) => { suits[c.suit()]++; });
    let use_suit = suits.map((c,i) => [i,c]).filter((pair) => pair[1] == 5)[0][0];
    let have_flush_ace = cards.filter((c) => {
        let cond1 = c.suit() == use_suit;
        let cond2 = c.rank() == 1;
        return cond1 && cond2;
    }).length;
    let use_rank = top_rank;
    if (have_flush_ace) {
        use_rank = 1;
    }
    return new Card((use_rank - 1) * 4 + (use_suit - 1));
}

class HandcalcTestRig {
    run_handcalc_program: IProgram
    run_onehandcalc_program: IProgram

    constructor() {
        // Load programs.
        const run_handcalc_hex = fs.readFileSync('clvm-hex/run_handcalc.hex', 'utf8');
        this.run_handcalc_program = Program.from_hex(run_handcalc_hex);
        const run_onehandcalc_hex = fs.readFileSync('clvm-hex/run_onehandcalc.hex', 'utf8');
        this.run_onehandcalc_program = Program.from_hex(run_onehandcalc_hex);
    }

    hand_description_from_onehandcalc(cards, ohc_output) {
        if (ohc_output[0] == 5) {
            let high_card = use_ace_for_flush_if_needed(cards, Number(ohc_output[1]));
            return `Straight Flush, ${poker_lib_string_of_rank(high_card.rank())}${string_of_suit(high_card.suit())} High`;
        } else if (ohc_output[0] == 4) {
            // Four of a kind
            return `Four of a Kind, ${poker_lib_string_of_rank(ohc_output[2])}'s`;
        } else if (ohc_output[0] == 3) {
            if (ohc_output[1] == 1 && ohc_output[2] == 3) {
                let high_card = use_ace_for_flush_if_needed(cards, Number(ohc_output[3][0]));
                return `Flush, ${poker_lib_string_of_rank(high_card.rank())}${string_of_suit(high_card.suit())} High`;
            } else if (ohc_output[1] == 1 && ohc_output[2] == 2) {
                return `Straight, ${poker_lib_string_of_rank(ohc_output[3])} High`;
            } else if (ohc_output[1] == 1 && ohc_output[2] == 1) {
                // Three of a kind
                return `Three of a Kind, ${poker_lib_string_of_rank(ohc_output[3])}'s`;
            } else if (ohc_output[1] == 2) {
                // Full house
                return `Full House, ${poker_lib_string_of_rank(ohc_output[2])}'s over ${poker_lib_string_of_rank(ohc_output[3])}'s`;
            }
        } else if (ohc_output[0] == 2) {
            if (ohc_output[1] == 2) {
                // We give king high, but library gives ace high.
                if (ohc_output[4] == 1) {
                    ohc_output[4] = ohc_output[3];
                    ohc_output[3] = 1;
                }
                return `Two Pair, ${poker_lib_string_of_rank(ohc_output[3])}'s & ${poker_lib_string_of_rank(ohc_output[4])}'s`;
            } else {
                // Pair
                return `Pair, ${poker_lib_string_of_rank(ohc_output[4])}'s`;
            }
        } else {
            // High card
            return `${poker_lib_string_of_rank(ohc_output[5])} High`;
        }
    }

    cards_from_bitmap(cards, bitmap) {
        const chosen_cards = [];
        for (var idx = 0; idx < cards.length; idx++) {
            if (bitmap & (1 << idx)) {
                chosen_cards.push(cards[idx]);
            }
        }
        return chosen_cards;
    }

    run_handcalc(cards) {
        // Form argument to handcalc.
        const cards_clvm = Program.to([cards.map((c) => t(c.rank(), c.suit()))]);
        let chosen_cards = [];

        // Run handcalc.  The result is a bitmap on the cards.
        const [cost, result] = this.run_handcalc_program.run(cards_clvm);
        return this.cards_from_bitmap(cards, result.as_int());
    }

    run_onehandcalc(cards) {
        // Run onehandcalc.  The result is a description of a hand.
        const test_cards_clvm = Program.to([cards.map((c) => t(c.rank(), c.suit()))]);
        const [cost, result] = this.run_onehandcalc_program.run(test_cards_clvm);
        return result.as_javascript();
    }

    run_card_hand_test(cards) {
        // Three of a kind hand.
        const chosen_cards = this.run_handcalc(cards);
        const classified = this.run_onehandcalc(chosen_cards);
        const hand = Hand.solve(chosen_cards.map((c) => c.toString()));

        assert.equal(this.hand_description_from_onehandcalc(chosen_cards, classified), hand.descr);

        return {
            'hand': hand,
            'chosen': chosen_cards,
            'classified': classified
        };
    }
}

it('can try playing poker hands', async () => {
    // Make some cards
    const deck = new CardDeck(99, 3, 17);
    const cards = deck.deal(7);
    assert.equal(cards.join(','), '5d,5c,6d,Tc,9h,5h,3s');

    const test_rig = new HandcalcTestRig();

    let cards_result = null;
    try {
        cards_result = test_rig.run_card_hand_test(cards);
    } catch (e) {
        assert.equal(e, null);
    }

    assert.equal(cards_result.hand.descr, "Three of a Kind, 5's");
});

function rnd() {
    return Math.floor(Math.random() * 200);
}

it('can deal with arbitrary card choices', async () => {
    const test_rig = new HandcalcTestRig();

    // Generate 1000 hands and check them.
    for (let i = 0; i < 1000; i++) {
        const deck = new CardDeck(rnd(), rnd(), rnd());
        const cards = deck.deal(7);
        try {
            let cards_result = test_rig.run_card_hand_test(cards);
        } catch (e) {
            assert.equal(e, null);
        }
    }
});
