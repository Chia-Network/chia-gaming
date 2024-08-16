let all_selected_cards = [{}, {}];

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

function check() {
    return fetch("idle.json", {
        "method": "POST"
    }).then((response) => {
        return response.json();
    }).then((json) => {
        if (json.info) {
            const info = document.getElementById('info');
            info.innerHTML = json.info;
        }
        if (json.p1) {
            const p1 = document.getElementById('p1');
            p1.innerHTML = json.p1;
        }
        if (json.p2) {
            const p2 = document.getElementById('p2');
            p2.innerHTML = json.p2;
        }

        set_card_properties('alice', all_selected_cards[0]);
        set_card_properties('bob', all_selected_cards[1]);

        setTimeout(check, 500);
    });
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

function alice_toggle(n) {
    toggle_card(`alice_card${n}`, all_selected_cards[0], n);
}

function bob_toggle(n) {
    toggle_card(`bob_card${n}`, all_selected_cards[1], n);
}

function set_picks(who, id) {
    let picks = '';
    for (let i = 0; i < 8; i++) {
        let n_string = `_${i}`;
        picks += (all_selected_cards[id][n_string]) ? '1' : '0';
    }
    return fetch(`${who}_picks?cards=${picks}`, {
        "method": "POST"
    });
}

function set_alice_picks() {
    set_picks('alice', 0);
}

function set_bob_picks() {
    set_picks('bob', 1);
}

function exitapp() {
    return fetch("exit", {"method": "POST"}).then((response) => {
        console.log("exiting...");
    });
}

check();
