Serving the chia-gaming lobby
---

Parts of the archive:

```chia-gaming-lobby/```

...nginx/lobby.conf
===

Edit this to change the variables defined at the top to reflect how you're serving
the lobby, then put it in ```/etc/nginx/sites-available``` and symlink into ```/etc/nginx/sites-enabled```.

This will keep your game alive in the tracker.

...dist
===
...public
===

Put these directories in the directory you identified to nginx as ```$content_root```.

...dist/index-rollup.cjs
===

Run this with node 20.18.1 or newer (from daemonize, systemd or similar).
Provide the parameter '--self' with the public facing origin used to contact the
lobby service.  This same origin will be used in the game service to contact its
beacon and set permission headers allowing the services to cooperate.
