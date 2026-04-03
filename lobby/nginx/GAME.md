Serving the calpoker game
---

Before starting
===

You should:

- Know what lobby you'll be using (or set up your own)
- Know what dns name you'll be using and set up the correct forwarding
- Know how you want to set up the server

Scripts and setup are provided for an ubuntu linux vm as you'd get on ec2 and others.

Packages installed:

- unzip (for the archive)
- trurl (for the install script)
- nginx

Using the archive and script
===

On an ubuntu vm, you can use the install script to add a configuration file to
nginx to serve the game content.

Assuming you have DNS pointing to this vm as ```my-calpoker-domain.com``` and you're
using ```tracker-to-use.com``` as a tracker, this will copy files and create
the right directories:

    unzip chia-gaming-frontend.zip
    cd chia-gaming-game
    sudo sh ./game-install.sh  --nginx /etc/nginx/sites-available/ --self https://my-calpoker-domain.com --port 443 --tracker https://tracker-to-use.com

Script options
===

```--nginx``` -- Specifies the directory where your nginx installation keeps the server configuration (usually sites-available).
```--content-root``` -- Specifies the directory where you want the game content to be stored.  This will be configured in the configuration file given to nginx.
```--self``` -- Specifies the origin part of the external url by which this service will be known.  It must match the DNS configuration that allows the game to be served as the lobby will redirect players to this url when starting a game.
```--tracker``` -- Specifies the origin part of the external url by which the tracker will be contacted.
```--port``` -- Optional specification of the listen port for the nginx configuration.  If you're reverse proxying, it might be useful for this not to be port 443.

Parts of the archive
===

These are the tasks needed to complete at a high level:

- Copy the served files somewhere to be served (example nginx configuration
  provided).  It's possible to serve the game entirely from a cdn, but it's beyond
  the scope of this document at present.

- Configure nginx by customizing game.conf and causing nginx to use it.

nginx/game.conf
===

Edit this to change the variables defined at the top to reflect how you're serving
the game, then put it in ```/etc/nginx/sites-available``` and symlink into ```/etc/nginx/sites-enabled```.  Note that you should set the listen port at the
top and customize the variables provided.

dist, public, clsp
===

Put these directories in the directory you identified to nginx as ```$content_root```.
