let all_selected_cards = {};
let have_made_move_in_current_state = false;
let most_recent_state = null;
let latched_in_move_state = null;
let made_move = false;
let auto_moves = {
    "BeforeAliceWord": true,
    "WaitingForAliceWord": true
};
let label_by_rank = "0123456789JQKA";
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

function auto_move() {
    let params = get_params();
    return params['auto'];
}

function set_card_properties(who, collection) {
    for (let i = 0; i < 8; i++) {
        let label = `${who}_card${i}`;
        let card = document.getElementById(label);
        if (!card) {
            continue;
        }
        let n_string = `_${i}`;
        if (collection[n_string]) {
            card.style.background = 'green';
        } else {
            card.style.background = 'white';
        }
    }
}


function send_alice_word() {
    let word = Math.random().toString();
    return fetch(`alice_word_hash?word=${word}`, {
        "method": "POST"
    });
}

function send_bob_word() {
    let word = Math.random().toString();
    return fetch(`bob_word_hash?word=${word}`, {
        "method": "POST"
    });
}

function toggle_card(label, selected_cards, n) {
    let n_string = `_${n}`;
    let card = document.getElementById(label);
    if (!card) {
        return;
    }
    if (selected_cards[n_string]) {
        card.style.background = 'white';
        delete selected_cards[n_string];
    } else {
        card.style.background = 'green';
        selected_cards[n_string] = true;
    }
    console.log(selected_cards);
}

function set_picks(who, id) {
    let picks = '';
    for (let i = 0; i < 8; i++) {
        let n_string = `_${i}`;
        picks += (all_selected_cards[n_string]) ? '1' : '0';
    }
    return fetch(`${who}_picks?cards=${picks}`, {
        "method": "POST"
    });
}

function take_auto_action(player_id, json) {
    console.log(`take auto action ${player_id} ${JSON.stringify(json)}`);
}

function generate_alice_entropy(player_id) {
    return fetch(`alice_word_hash?arg=${player_id}${Math.random()}`, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        latched_in_move_state = null;
        made_move = true;
    });
}

function generate_bob_entropy(player_id) {
    return fetch(`bob_word_hash?arg=${player_id}${Math.random()}`, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        latched_in_move_state = null;
        made_move = true;
    });
}

function render_card(card) {
    let card_span = document.createElement('span');
    card_span.setAttribute('class','card');
    card_span.innerHTML = `<div class='rank${card[0]} suit${card[1]}'><div class='card_top'>${label_by_suit[card[1]]}</div><div class='card_bot'>${label_by_rank[card[0]]}</div>`;
    return card_span;
}

function make_card_row(div, cards) {
    for (let ci = 0; ci < cards.length; ci++) {
        div.appendChild(render_card(cards[ci]));
    }
}

function allow_manual_move(player_id, move, json) {
    console.log(`allow manual move ${player_id} ${move} ${JSON.stringify(json)}`);
    let element = document.getElementById('playspace');
    if (move === 'BeforeAliceWord') {
        element.innerHTML = `<h2>You must generate a secret value and send a hash commitment</h2><div><button onclick="generate_alice_entropy(${player_id})">Generate secret value</button>"`;
    } else if (move === 'WaitingForAlicePicks') {
        element.innerHTML = `<h2>You must generate a secret value and send part of a hash commitment</h2><div><button onclick="generate_bob_entropy(${player_id})">Generate secret value</button>"`;
    } else if (move === 'BeforeAlicePicks') {
        element.innerHTML = "<h2>You must choose four of these cards</h2><div id='card-choices'></div><h2>Your opponent is being shown these cards</h2><div id='opponent-choices'></div>";
        let choices = document.getElementById('card-choices');
        if (typeof(json.readable) !== 'string' && json.readable.length == 2) {
            make_card_row(choices, json.readable[0]);
        }
        let opponent = document.getElementById('opponent-choices');
        if (typeof(json.readable) !== 'string' && json.readable.length == 2) {
            make_card_row(opponent, json.readable[1]);
        }
    } else {
        element.innerHTML = `unhandled state ${move}`;
    }
}

function take_update(player_id, auto, json) {
    if (json.can_move) {
        let first_time_seeing_state = null;
        if (json.state !== most_recent_state) {
            first_time_seeing_state = json.state;
            most_recent_state = json.state;
        }

        if (first_time_seeing_state) {
            if (auto && auto_moves[first_time_seeing_state]) {
                take_auto_action(player_id, json);
            } else {
                latched_in_move_state = first_time_seeing_state;
                made_move = false;
            }
        }
    }

    if (made_move || json.our_move.length) {
        let element = document.getElementById('playspace');
        element.innerHTML = "Sent move waiting for state change.";
    } else if (latched_in_move_state && !made_move) {
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
    let auto = auto_move() == "true";
    let do_auto_move = auto ? 'automatic default moves' : 'manual moves';

    let h1 = document.getElementById('player-heading');
    clear(h1);
    h1.appendChild(document.createTextNode(`Player ${player_id} - ${do_auto_move}`));

    return fetch(`player.json?id=${player_id}`, {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        take_update(player_id, auto, json);
        setTimeout(check, 500);
    });
}

check();
