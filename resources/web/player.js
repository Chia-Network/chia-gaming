let all_selected_cards = {};

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
    return fetch(`bob_word?word=${word}`, {
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

function take_update(player_id, auto, json) {
    let keys = Object.keys(json);

    let info = document.getElementById('player-info');
    clear(info);

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
    auto_move = auto ? 'automatic default moves' : 'manual moves';

    let h1 = document.getElementById('player-heading');
    clear(h1);
    h1.appendChild(document.createTextNode(`Player ${player_id} - ${auto_move}`));

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
