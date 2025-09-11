Serialization data
====

Things we must serialize:
---

- Referee
- Channel handler
- Potato handler
- Peer container
- Outside information (game thinks it's in turn x, wallet connected to)

Identifying objects to serialize:
---
Peer container -> potato handler -> channel handler, game_map
channel handler

We should store it all in a json ball but make the channel handler and the referee
objects easy to identify since they own the active state.  You can do most things
such as going on chain or carrying out the game on chain with that data.

Secondarily, if you take the potato handler, you can continue using the protocol.

We need to accomodate receiving the same message more than once, so we'll put a
message number on them that monotonically increases.

When potato handler receives a message that's prior to the one it knows, it will
ignore the message.

- We will need a speecial handler for the referee interface held by LiveGame.

Things it must support:
---

1) Command line tool that can spill on chain and finish games and the channel
2) Checkpoint when we go on chain
3) Produce save data when requested
4) Have a rehydrate function that can create and return the subset of objects
   we specify (just the referees, just the channel handler, just the potato
   handler, etc).

A thing we'll need:
---

We need to ensure that our serialization tags all the important structs:
- Referee
- Channel handler
- Potato handler

Making these easy to identify in the json output is important.
