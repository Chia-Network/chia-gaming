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

        setTimeout(check, 500);
    });
}

function exitapp() {
    return fetch("exit", {"method": "POST"}).then((response) => {
        console.log("exiting...");
    });
}

check();
