#

# Artifacts produced from this repository

## Chia Gaming Lobby Service

This service allows players to advertise that they are available for a game, or accept another player's game invitation.

The lobby API helps bootstrap the peer-to-peer channel used as an offchain message channel.

This service will expose API endpoints at /api/v[0-9][0-9]/

There will also be static web files implementing the user-facing website that queries the Lobby API, and displays the list of available games.

The Lobby keeps a small amount of reboot-persistent state describing games that have been offered, but not yet started.

We may eventually want to retire old entries in the DB.

We expect more reads than writes.

[Code](../src/lobby/)

This could be hosted at e.g. chia-gaming.net or gaming.chia.net

### Lobby REST Endpoints

### Game Object JSON Schema

## Calpoker

This is a Chia Gaming example gamemiplemented as static website that may make API calls to the Chia Gaming Lobby Service.

Local user state is kept in [localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage), in the user's browser.

It is not clear if we will host these games, or simply make the source code and documentation available.

What sounds good? calpoker.chia-gaming.net?

### Code

The code for the calpoker website: (insert image here)