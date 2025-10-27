Serving calpoker
---

Parts of the archive:

```chia-game-deploy-x.y.z/...```

...nginx/game.conf
===

Edit this to change the variables defined at the top to reflect how you're serving
the game, then put it in ```/etc/nginx/sites-available``` and symlink into ```/etc/nginx/sites-enabled```.

...beacon.sh
===

Run this script from systemd or elsewhere when the game is being served like this:

    beacon.sh https://my_calpoker_domain.com https://tracker_domain.com

This will keep your game alive in the tracker.

...app
===

Put the app directory in the directory you identified to nginx as ```$content_root```.
