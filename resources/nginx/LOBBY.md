Serving the chia-gaming lobby
---

Before starting
===

You should:

- Know what dns name you'll be using and set up the correct forwarding
- now how you want to set up the server

Scripts and setup are provided for an ubuntu linux vm as you'd get on ec2 and others.

Packages installed:

- unzip (for the archive)
- trurl (for the install script)
- nginx
- nodejs

Using the archive and script
===

On an ubuntu vm, you can use the install script to add a configuration file to nginx to serve the lobby content, and add a systemd service for the lobby server.

Assuming you have DNS pointing to this vm as ```tracker-to-use.com```, this will copy the files and create the right directories:

    unzip chia-gaming-lobby.zip
    cd chia-gaming-lobby
    sudo sh ./lobby-install.sh --nginx /etc/nginx/sites-available --content-root /var/www/html/lobby --service /opt/service/lobby --self-url https://tracker-to-use.com --port 443

Script options
===

```--nginx``` -- Specifies the directory where your nginx installation keeps the server configuration (usually sites-available).
```--content-root``` -- Specifies the directory where you want the game content to be stored.  This will be configured in the configuration file given to nginx.
```--self-url``` -- Specifies the origin part of the external url by which this service will be known.  It must match your DNS configuration.
```--service``` -- Specifies the directory from which the json rpc service is run.
```--port``` -- Optional, specifies the port you'll use if you're reverse proxying and don't want to use port 443.

Parts of the archive:

```chia-gaming-lobby/```

nginx/lobby.conf
===

Edit this to change the variables defined at the top to reflect how you're serving
the lobby, then put it in ```/etc/nginx/sites-available``` and symlink into ```/etc/nginx/sites-enabled```.

dist, public
===

Put these directories in the directory you identified to nginx as ```$content_root```.

dist/index-rollup.cjs
===

Run this with node 20.18.1 or newer (from daemonize, systemd or similar).
Provide the parameter '--self' with the public facing origin used to contact the
lobby service.  This same origin will be used in the game service to contact its
beacon and set permission headers allowing the services to cooperate.
