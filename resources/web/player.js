let label_by_rank = "0A23456789\u{2469}JQK";
let label_by_suit = "Y\u{2660}\u{2665}\u{2663}\u{2666}";

function clear(elt) {
    for (let node = elt.firstChild; node; node = elt.firstChild) {
        node.parentNode.removeChild(node);
    }
}

function describe_hand(description, cards) {
    let convert_ranks = (ranks) => {
        return ranks.map((card) => {
            if (card === 14) {
                card = 1;
            }
            return label_by_rank[card];
        });
    };
    let keys_of_description = Object.keys(description);
    let hand_type = keys_of_description[0];
    let hand_data = description[hand_type];
    if (hand_type === 'Flush') {
        return `Flush of ${convert_ranks(hand_data)}`;
    } else if (hand_type == 'Straight') {
        return `Straight high ${convert_ranks([hand_data])}`;
    } else if (hand_type == 'FullHouse') {
        let ranks = convert_ranks([hand_data[0], hand_data[1]]);
        return `Full House of ${ranks[1]} and ${ranks[0]}`;
    } else if (hand_type === 'Pair') {
        let rank = convert_ranks([hand_data[0]]);
        return `Pair of ${rank}s`;
    } else if (hand_type === 'ThreeOfAKind') {
        let rank = convert_ranks([hand_data[0]]);
        return `Three ${rank}s`;
    } else if (hand_type === 'TwoPair') {
        let ranks = convert_ranks([hand_data[0], hand_data[1]]);
        return `Pairs of ${ranks[0]} and ${ranks[1]}`;
    } else {
        return `${hand_type} ${hand_data}`;
    };
}

function get_params() {
    let param_str = window.location.search.substring(1);
    let pssplit = param_str.split('&');
    let params = {};
    for (let pi = 0; pi < pssplit.length; pi++) {
        let pset = pssplit[pi].split('=');
        if (pset.length != 2) {
            continue;
        }
        params[pset[0]] = pset[1];
    }
    return params;
}

function get_player_id() {
    let params = get_params();
    return params['id'];
}

function auto_move(json) {
    return json.auto;
}

function is_outcome(readable) {
    return typeof(readable) !== 'string';
}

class PlayerController {
    constructor() {
        this.params = get_params();
        this.player_id = get_player_id();
        this.all_selected_cards = {};
        this.ui_wait = false;
        this.eat_toggle = false;
        this.player_info = false;
    }

    toggle_card(label, selected_cards, n) {
        if (this.eat_toggle) {
            this.eat_toggle = false;
            return;
        }
        if (selected_cards[label]) {
            delete selected_cards[label];
        } else {
            selected_cards[label] = true;
        }

        update_card_after_toggle(label);

        let num_selected_cards = Object.keys(selected_cards).length;
        let submit_button = document.getElementById('submit-picks');
        if (submit_button) {
            if (num_selected_cards == 4) {
                submit_button.removeAttribute('disabled');
            } else {
                submit_button.setAttribute('disabled', true);
            }
        }
    }

    take_auto_action(json) {
        console.log(`take auto action ${this.player_id} ${JSON.stringify(json)}`);
        if ((json.state == 'BeforeAliceWord' || json.state == 'BeforeBobWord') && json.move_number < 1) {
            this.sent_word = true;
            generate_entropy(this.player_id);
        } else if ((json.state == 'BeforeAliceFinish' || json.state == 'BeforeBobFinish' || json.state == 'BobEnd') && json.move_number < 3 && typeof(json.readable) !== 'string' ) {
            console.error('end game');
            end_game(this.player_id);
        }
    }

    maybe_selected(label) {
        return !!this.all_selected_cards[label];
    }

    pick_word(json) {
        let button = '';
        if (json.can_move && !auto_move(json)) {
            button = `<button onclick="generate_entropy(${this.player_id})">Generate secret value</button>`;
        }

        if (auto_move(json) && json.move_number < 1) {
            this.take_auto_action(json);
        }

        return `<h2>You must generate a secret value and send a hash commitment</h2><div>${button}`;
    }

    after_word(json) {
        let have_card_data = typeof(json.readable) !== 'string' && json.readable.length == 2 && json.readable[0].length > 0;
        let html_result = null;
        let card_result = null;

        if (have_card_data) {
            let num_selected_cards = Object.keys(this.all_selected_cards).length;
            let submit_disabled = (num_selected_cards !== 4) ? 'disabled' : '';

            let submit_button =
                have_card_data ?
                `<div id='picks-submit-div'><button id='submit-picks' class='sent_picks_${json.move_number > 1}' onclick='submit_picks(${this.player_id})' ${submit_disabled}>Submit picks</button></div>` :
                '';
            if (this.player_id == 2) {
                card_result = [json.readable[1], json.readable[0]];
            } else {
                card_result = json.readable;
            }
            html_result = `<h2>Choose 4 cards to give your opponent</h2><h3>You'll receive 4 cards from them</h3>${submit_button}<div id='card-choices'></div><h2>Your opponent is being shown these cards</h2><div id='opponent-choices'></div>`;
} else {
            html_result = '<h2>Waiting for cards<h2>';
        }

        return [html_result, card_result];
    }

    finish_move(json) {
        if (auto_move(json)) {
            this.take_auto_action(json);
            return `<h2>Finishing game</h2>`;
        }

        let submit_button =
            json.move_number < 3 && (this.player_id == 1 || json.received_moves > 2) ?
            `<button id='submit-finish' onclick='end_game(${this.player_id})'>Click to finish game</button>` : '';

        return `<h2>Waiting to finish game</h2><div id='finish-submit'>${submit_button}</div>`;
    }

    end_game_state(json) {
        let result;

        if (typeof(json.readable) !== 'string' && json.readable.raw_alice_selects) {
            result = `<h2>Game outcome</h2><div>${game_outcome(this.player_id, json, json.known_cards)}</div><div id='card-choices-end-label'>Your cards</div><div id='card-choices'></div><div id='other-choices-end-label'>Their cards</div><div id='opponent-choices'></div>`;
        } else {
            result = '<h2>Waiting for game outcome</h2>';
        }

        if (this.player_id == 1) {
            return [result, json.known_cards];
        } else {
            return [result, [json.known_cards[1], json.known_cards[0]]];
        };
    }


    toggle_player_info() {
        let pi = document.getElementById('player-info');
        if (pi) {
            this.player_info = !this.player_info;
            pi.setAttribute('class', `player-info-${this.player_info}`);
        }
    }
}

let controller = new PlayerController();

function update_card_after_toggle(label) {
    let card = document.getElementById(label);
    if (!card) {
        return;
    }

    let classes = card.getAttribute('class').split(' ');
    for (let i = 0; i < classes.length; i++) {
        if (classes[i].startsWith('selected_')) {
            classes[i] = `selected_${!!controller.all_selected_cards[label]}`;
        }
    }
    card.setAttribute('class', classes.join(" "));
}

function post(url) {
    return fetch(url, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    });
}

function submit_picks(player_id) {
    let picks = '';
    for (let i = 0; i < 8; i++) {
        picks += (controller.all_selected_cards[`_${i}`]) ? '1' : '0';
    }
    console.log('doing picks for',player_id);
    return post(`picks?arg=${player_id}${picks}`).then((json) => {
        controller.ui_wait = false;
        console.log('ui_wait off');
    }).catch((e) => {
        console.error('submit_picks', e);
    });
}

function generate_entropy(player_id) {
    let alice_entropy = Math.random().toString();
    return post(`word_hash?arg=${player_id}${alice_entropy}`).then((json) => {
    });
}

function end_game(id) {
    return post(`finish?id=${id}`).then((json) => {
    });
}


function render_card(card, n, label, toggleable) {
    let card_span = document.createElement('span');
    card_span.setAttribute('id', label);
    card_span.setAttribute('class',`card selected_${controller.maybe_selected(label)}`);
    let toggle_string = toggleable ? `onclick="controller.toggle_card('${label}',controller.all_selected_cards,${n})"` : '';
    card_span.innerHTML = `<div class='rank${card[0]} suit${card[1]}' ${toggle_string}><div class='card_top'>${label_by_suit[card[1]]}</div><div class='card_bot'>${label_by_rank[card[0]]}</div>`;
    return card_span;
}

function make_card_row(div, cards, label_prefix, toggleable) {
    for (let ci = 0; ci < cards.length; ci++) {
        div.appendChild(render_card(cards[ci], ci, `${label_prefix}${ci}`, toggleable));
    }
}

function game_outcome(player_id, json, cards) {
    let card_outcome = '';

    if (!json.readable || typeof(json.readable) === 'string') {
        return 'Waiting...';
    }

    let winner = json.readable.win_direction * ((player_id == 1) ? 1 : -1);
    let winner_text;

    if (winner == 1) {
        winner_text = "You win";
    } else if (json.readable.win_direction == 0) {
        winner_text = "Draw";
    } else {
        winner_text = "Opponent wins";
    }

    if (is_outcome(json.readable)) {
        let hand_desc = player_id == '1' ? 'alice_hand_result' : 'bob_hand_result';
        let oppo_desc = player_id == '1' ? 'bob_hand_result' : 'alice_hand_result';
        let hand_cards = cards[0];

        card_outcome = `<div id='outcome-line-1'>Your hand ${describe_hand(json.readable[hand_desc], cards)}</div><div id='outcome-line-2'>Opponent hand ${describe_hand(json.readable[oppo_desc])}</div>`;
    }

    return `<div class='outcome-heading winner-${winner}'>${winner_text}</div>${card_outcome}`;
}

function allow_manual_move(player_id, json) {
    let move = json.state;
    let card_data = null;
    let element = document.getElementById('playspace');

    if (move === 'BeforeAliceWord' || move === 'BeforeBobWord') {
        element.innerHTML = controller.pick_word(json);
    } else if (move === 'AfterAliceWord' || move === 'BeforeAlicePicks' || move === 'BeforeBobPicks' || move === 'AfterBobWord' && json.move_number < 2) {
        let picks_result = controller.after_word(json);
        element.innerHTML = picks_result[0];
        card_data = picks_result[1];
    } else if (move === 'BeforeAliceFinish') {
        element.innerHTML = controller.finish_move(json);
    } else if (move === 'AliceEnd' || move === 'BobEnd') {
        let result = controller.end_game_state(json);
        element.innerHTML = result[0];
        card_data = result[1];
    } else {
        element.innerHTML = `unhandled state ${move}`;
    }

    if (card_data && card_data.length === 2 && card_data[0].length > 0) {
        $("#card-choices").sortable({
            update: function() {
                controller.eat_toggle = true;
            }
        });

        $("#opponent-choices").sortable();

        let our_cards = card_data[0];
        let their_cards = card_data[1];
        let choices = document.getElementById('card-choices');
        let opponent = document.getElementById('opponent-choices');
        if (choices) {
            make_card_row(choices, our_cards, '_', true);
        }
        if (opponent) {
            make_card_row(opponent, their_cards, 'opponent', false);
        }
    }
}

function take_update(player_id, json) {
    allow_manual_move(player_id, json);

    let info = document.getElementById('player-info');
    clear(info);

    let keys = Object.keys(json);
    for (let ki = 0; ki < keys.length; ki++) {
        let key = keys[ki];
        let val = json[key];
        let new_elt = document.createElement('span');
        new_elt.setAttribute('class', 'player-attr');
        let tn = document.createTextNode(`${key}: ${val}`);
        new_elt.appendChild(tn);
        info.appendChild(new_elt);
    }
}

let last_update = '';

function check() {
    let player_id = get_player_id();

    return fetch(`player.json?id=${player_id}`, {
        "method": "POST"
    }).then((response) => {
        return response.json().catch((e) => {
            let error = document.getElementById('player-error');
            error.innerHTML = JSON.stringify(e);
            return {};
        });
    }).then((json) => {
        let this_str = JSON.stringify(json);

        setTimeout(check, 500);
        if (this_str === last_update) {
            return;
        }

        last_update = this_str;
        // Color the text of the player field when waiting for a message
        let heading = document.getElementById('player-heading');
        heading.setAttribute("class", controller.ui_wait ? "player-heading-wait" : "player-heading");
        let do_auto_move = auto_move(json) ? 'automatic default moves' : 'manual moves';

        let h1 = document.getElementById('player-heading');
        clear(h1);
        h1.appendChild(document.createTextNode(`Player ${player_id} - ${do_auto_move}`));

        take_update(player_id, json);

    });
}

check();
