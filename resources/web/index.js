function clear(elt) {
    for (let node = elt.firstChild; node; node = elt.firstChild) {
        node.parentNode.removeChild(node);
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
            clear(info);
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

        setTimeout(check, 500);
    });
}

function reset() {
    return fetch("reset", {"method": "POST"}).then((response) => {
        console.log("reset...");
    });
}

function exitapp() {
    return fetch("exit", {"method": "POST"}).then((response) => {
        console.log("exiting...");
    });
}

check();
