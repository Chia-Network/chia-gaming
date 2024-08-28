let all_selected_cards = {};
let have_made_move_in_current_state = false;
let most_recent_state = null;
let latched_in_move_state = null;
let made_move = false;
let ui_wait = false;
let eat_toggle = false;
let bob_word = null;
let sent_word = false;
let sent_picks = false;
let sent_end = false;
let label_by_rank = "0A23456789\u{2469}JQK";
let label_by_suit = "Y\u{2660}\u{2665}\u{2663}\u{2666}";

function clear(elt) {
    for (let node = elt.firstChild; node; node = elt.firstChild) {
        node.parentNode.removeChild(node);
    }
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

function update_card_after_toggle(label) {
    let card = document.getElementById(label);
    if (!card) {
        return;
    }

    let classes = card.getAttribute('class').split(' ');
    for (let i = 0; i < classes.length; i++) {
        if (classes[i].startsWith('selected_')) {
            classes[i] = `selected_${!!all_selected_cards[label]}`;
        }
    }
    card.setAttribute('class', classes.join(" "));
}

function toggle_card(label, selected_cards, n) {
    if (eat_toggle) {
        eat_toggle = false;
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

function generate_alice_entropy(player_id) {
    let alice_entropy = Math.random().toString();
    return fetch(`alice_word_hash?arg=${player_id}${alice_entropy}`, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        latched_in_move_state = null;
        made_move = true;
    });
}

function generate_bob_entropy(player_id) {
    bob_word = Math.random().toString();
    return fetch(`bob_word_hash?arg=${player_id}${bob_word}`, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        latched_in_move_state = null;
        most_recent_state = null;
    });
}

function take_auto_action(player_id, json) {
    console.log(`take auto action ${player_id} ${JSON.stringify(json)}`);
    if (json.state == 'BeforeAliceWord' && !sent_word) {
        sent_word = true;
        generate_alice_entropy(player_id);
    } else if (json.state == 'WaitingForAlicePicks' && !sent_word) {
        sent_word = true;
        generate_bob_entropy(player_id);
    } else if ((json.state == 'AliceFinish1' || json.state == 'BobFinish1' || json.state == 'BobEnd') && !sent_end) {
        sent_end = true;
        console.error('end game');
        end_game(player_id);
    }
}

function end_game(id) {
    return fetch(`finish?id=${id}`, {
        "method": "POST"
    }).then((response) => {
        sent_end = true;
        return response.json();
    });
}


function maybe_selected(label) {
    return !!all_selected_cards[label];
}

function render_card(card, n, label, toggleable) {
    let card_span = document.createElement('span');
    card_span.setAttribute('id', label);
    card_span.setAttribute('class',`card selected_${maybe_selected(label)}`);
    let toggle_string = toggleable ? `onclick="toggle_card('${label}',all_selected_cards,${n})"` : '';
    card_span.innerHTML = `<div class='rank${card[0]} suit${card[1]}' ${toggle_string}><div class='card_top'>${label_by_suit[card[1]]}</div><div class='card_bot'>${label_by_rank[card[0]]}</div>`;
    return card_span;
}

function make_card_row(div, cards, label_prefix, toggleable) {
    for (let ci = 0; ci < cards.length; ci++) {
        div.appendChild(render_card(cards[ci], ci, `${label_prefix}${ci}`, toggleable));
    }
}

function submit_alice_picks() { submit_picks('alice'); }
function submit_bob_picks() { submit_picks('bob'); }

function submit_picks(name) {
    let picks = '';
    for (let i = 0; i < 8; i++) {
        picks += (all_selected_cards[`_${i}`]) ? '1' : '0';
    }
    fetch(`${name}_picks?arg=${picks}`, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        ui_wait = false;
        made_move = true;
        sent_picks = true;
    }).catch((e) => {
        console.error('submit_picks', e);
    });
}

function game_outcome(player_id, json) {
    if (!json.readable || typeof(json.readable) === 'string') {
        return 'Waiting...';
    }

    let winner = json.readable.win_direction * ((player_id == 1) ? 1 : -1);
    let winner_text;

    if (winner == -1) {
        winner_text = "You win";
    } else if (json.readable.win_direction == 0) {
        winner_text = "Draw";
    } else {
        winner_text = "Opponent wins";
    }

    return winner_text;
}

function allow_manual_move(player_id, move, json) {
    let element = document.getElementById('playspace');
    let show_cards = false;
    let have_card_data = typeof(json.readable) !== 'string' && json.readable.length == 2 && json.readable[0].length > 0;

    if (move === 'BeforeAliceWord') {
        element.innerHTML = `<h2>You must generate a secret value and send a hash commitment</h2><div><button onclick="generate_alice_entropy(${player_id})">Generate secret value</button>"`;
        if (auto_move(json) && !made_move) {
            made_move = true;
            take_auto_action(player_id, json);
        }
    } else if (move === 'WaitingForAlicePicks') {
        if (have_card_data) {
            let num_selected_cards = Object.keys(all_selected_cards).length;
            let submit_disabled = (num_selected_cards !== 4) ? 'disabled' : '';
            let submit_button =
                have_card_data ?
                `<div id='picks-submit-div'><button id='submit-picks' class='sent_picks_${sent_picks}' onclick='submit_bob_picks()' ${submit_disabled}>Submit picks</button></div>` :
                '';
            element.innerHTML = `${submit_button}<h2>You must choose four of these cards</h2><div id='card-choices'></div><h2>Your opponent is being shown these cards</h2><div id='opponent-choices'></div>`;
            show_cards = 'bob';
        } else {
            let move_button =
                bob_word ?
                '' :
                `<button onclick="generate_bob_entropy(${player_id})">Generate secret value</button>`;

            element.innerHTML = `<h2>You must generate a secret value and send part of a hash commitment</h2><div>${move_button}</div>"`;

            if (auto_move(json) && !made_move) {
                made_move = true;
                take_auto_action(player_id, json);
            }
        }
    } else if (move === 'BeforeAlicePicks') {
        let num_selected_cards = Object.keys(all_selected_cards).length;
        let submit_disabled = (num_selected_cards !== 4) ? 'disabled' : '';
        let submit_button =
            have_card_data ?
            `<button id='submit-picks' class='sent_picks_${sent_picks}' onclick='submit_alice_picks()' ${submit_disabled}>Submit picks</button>` :
            '';

        element.innerHTML = `<h2>You must choose four of these cards</h2><div id='picks-submit-div'>${submit_button}</div><div id='card-choices'></div><h2>Your opponent is being shown these cards</h2><div id='opponent-choices'></div>`;
        show_cards = 'alice';
    } else if (move === 'AliceFinish1' || move === 'AliceEnd' || move === 'BobFinish1' || move === 'BobEnd') {
        let submit_button =
            !sent_end ?
            `<button id='submit-finish' onclick='end_game(${player_id})'>Click to finish game</button>` : '';

        element.innerHTML = `<h2>Game outcome</h2><div id='finish-submit'>${submit_button}</div><div>${game_outcome(player_id, json)}</div><div>${JSON.stringify(json.readable)}</div>`;

        if (!sent_end && auto_move(json) && !made_move) {
            made_move = true;
            take_auto_action(player_id, json);
        }
    } else {
        element.innerHTML = `unhandled state ${move}`;
    }

    if (show_cards && have_card_data) {
        $("#card-choices").sortable({
            update: function() {
                eat_toggle = true;
            }
        });
        $("#opponent-choices").sortable();

        if (!sent_picks && typeof(json.readable) !== 'string' && json.readable.length == 2 && json.readable[0].length > 0) {
            ui_wait = true;
        }

        let our_cards = show_cards == 'alice' ? 0 : 1;
        let their_cards = our_cards ^ 1;
        let choices = document.getElementById('card-choices');
        make_card_row(choices, json.readable[our_cards], '_', true);
        let opponent = document.getElementById('opponent-choices');
        make_card_row(opponent, json.readable[their_cards], 'opponent', false);
    }
}

function take_update(player_id, json) {
    if (json.can_move) {
        let first_time_seeing_state = null;
        if (json.state !== most_recent_state) {
            first_time_seeing_state = json.state;
            most_recent_state = json.state;
        }

        if (first_time_seeing_state) {
            latched_in_move_state = first_time_seeing_state;
            console.log('made move', made_move);
            made_move = false;
        }
    }

    if (latched_in_move_state) {
        allow_manual_move(player_id, latched_in_move_state, json);
    }

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

function check() {
    let player_id = get_player_id();

    return fetch(`player.json?id=${player_id}`, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        if (!ui_wait) {
            let do_auto_move = auto_move(json) ? 'automatic default moves' : 'manual moves';

            let h1 = document.getElementById('player-heading');
            clear(h1);
            h1.appendChild(document.createTextNode(`Player ${player_id} - ${do_auto_move}`));

            take_update(player_id, json);
        }
        setTimeout(check, 500);
    });
}

check();
