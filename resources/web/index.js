let auto = false;

function clear(elt) {
    for (let node = elt.firstChild; node; node = elt.firstChild) {
        node.parentNode.removeChild(node);
    }
}

function reload() {
    window.location.reload();
}

function update_ungate_button(json) {
    let gate_button = document.getElementById('message-button');
    if (json.info.gated_messages > 0) {
        gate_button.removeAttribute('disabled');
    } else {
        gate_button.setAttribute('disabled', true);
    }
}

let last_update = "";

function check() {
    return fetch("idle.json", {
        "method": "POST"
    }).then((response) => {
        return response.json().catch((e) => {
            return {"error": JSON.stringify(e)};
        });
    }).then((json) => {
        if (json.info) {
            let this_str = JSON.stringify(json);
            setTimeout(check, 500);
            if (this_str === last_update) {
                return;
            } else {
                last_update = this_str;
            }

            info = document.getElementById('info');
            clear(info);
            auto = json.info.auto;

            info.setAttribute("class", json.info.auto ? "info-auto" : "info-manual");
            update_ungate_button(json);

            let keys = Object.keys(json.info);
            let ul = document.createElement('ul');
            for (let i = 0; i < keys.length; i++) {
                let key = keys[i];
                let li = document.createElement('li');
                let tn = document.createTextNode(`${key}: ${json.info[key]}`);
                li.appendChild(tn);
                ul.appendChild(li);
            }
            info.appendChild(ul);
        }


    });
}

function reset() {
    return fetch("reset", {"method": "POST"}).then((response) => {
        console.log("reset...");
        setTimeout(reload, 2000);
    });
}

function exitapp() {
    return fetch("exit", {"method": "POST"}).then((response) => {
        console.log("exiting...");
    });
}

function toggle_auto() {
    return fetch(`set_auto?auto=${!auto ? 1 : 0}`, {"method": "POST"}).then((response) => {
        console.log("toggle auto...");
    });
}

function allow_message() {
    return fetch(`allow_message`, {"method": "POST"}).then((response) => {
        console.log("allow message...");
    });
}

check();
