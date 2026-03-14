# Frontend Architecture Direction

This document describes the target architecture for the frontend JavaScript/TypeScript
code. It is aspirational — the current codebase does not yet match this design. It
serves as a reference for future work.

For the backend/WASM architecture, see `ARCHITECTURE.MD`.

## Overview

The frontend is organized as a set of nested frames with strict containment
boundaries. Each frame has a well-defined trust level and responsibility. The
design supports future extension to multiple game types and multiple simultaneous
games, but the MVP is limited to one game at a time.

## Frame Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│  Parent Window (TRUSTED)                                        │
│  Wallet, blockchain, theme, chrome, channel-scope notifications │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Lobby iframe (UNTRUSTED — third-party code)             │   │
│  │  Matchmaking only; can only fire "connect to peer"       │   │
│  │  Persistent, always visible                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Game Session Frame (TRUSTED)                            │   │
│  │  WASM cradle, session info, between-game UX, logs        │   │
│  │                                                          │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  Game UI Frame (game-type-specific)                │  │   │
│  │  │  Knows only its game protocol                      │  │   │
│  │  │  Destroyed and recreated every hand                │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Parent Window

The parent window is our trusted code. It owns:

- **Wallet connection** (WalletConnect or simulator)
- **Blockchain monitoring** (block data, coin tracking)
- **Theme** (dark/light, CSS variables)
- **Global chrome** (header, balance display)
- **Channel-scope notifications** displayed as toasts

The parent window does not know about game types or game protocol details.

### Lobby Iframe

The lobby iframe is **untrusted**. It contains third-party code that provides
matchmaking UX. It can have whatever visual design and user experience it wants.

Its only capability visible to the rest of the application is firing a signal
that triggers a peer connection. The parent window listens for this signal and
ignores everything else from the lobby.

The lobby connection is persistent and always visible (e.g. as a tab). The UX
starts by allowing the user to navigate to a lobby. Both players connect to the
same lobby/tracker, and the lobby triggers both of them connecting to each other
— replacing the current manual URL-sharing flow.

### Game Session Frame

The game session frame is trusted code that manages one game session (a channel
with a series of individual hands). It owns:

- **WASM cradle** — the `ChiaGame`/`WasmBlobWrapper` lifecycle, persisting across
  hands within a session
- **Peer socket** — the socket.io connection to the other player
- **Session-level display** — how much money both players put in, coin IDs,
  whose real turn it is when playing on chain
- **Between-game UX** — an overlay showing the final result of each hand, a
  prompt to play again or end the session, and UX for renegotiating game terms
  (e.g. changing the per-game amount)
- **Edge-case / terminal game notifications** — timeouts, slashes, cancellations,
  errors, on-chain transitions. These are shown as overlays or toasts by the
  session frame. They never reach the game UI because they terminate or interrupt
  the game rather than interacting with gameplay.
- **Game log** — a simple text area that the game-type-specific JavaScript appends
  to (e.g. "You won with a flush" or "Opponent won with two pair"). Written to
  by the game UI, displayed by the session frame.
- **Debug log** — a simple text area that the session frame itself writes to,
  showing the actual protocol-level moves played and whether they were on-chain
  or off-chain.

Both logs are simple append-only text areas.

The session frame knows about game types at the lifecycle level: it knows which
game UI to load for a given game type, when to create or destroy the game UI
frame, and when to show the between-game overlay. It does not know game-specific
protocol details like calpoker's five-step commit-reveal flow.

### Game UI Frame

The game UI frame is game-type-specific. For calpoker, it contains all the
calpoker-specific JavaScript: card rendering, the five-step protocol (a through
e), nil moves, card selection, the swap animation, and the masking of
asynchronous play as a synchronous experience for the user.

It receives gameplay events routed from the session frame:

- `GameProposalAccepted` — a new game is starting
- `OpponentMoved` — the opponent made a move (with readable data)
- `GameMessage` — advisory data (e.g. Alice revealing cards to Bob early)

It sends moves back to the session frame and can append to the game log.

What the game UI does **not** know about:

- Blockchain, channels, wallets, unrolling, on-chain resolution
- Channel-scope events
- Other games (in the future when multiple games are supported)
- What happens when things go wrong at the channel level — the session frame
  handles all of that and simply destroys the game UI if needed

**The game UI frame is destroyed and recreated from scratch for every hand.**
A session consists of many short games in quick succession. Recreating the frame
on each hand ensures no stale state accumulates and eliminates cleanup logic.
The session frame's between-game overlay covers the transition.

## Notification Routing

WASM notifications fall into three categories based on where they are handled:

### Channel-scope → Parent Window

These relate to the state channel itself, not any individual game:

- `ChannelCreated`
- `GoingOnChain`
- `ChannelCoinSpent`
- `UnrollCoinSpent`
- `StaleChannelUnroll`
- `ChannelError`
- `CleanShutdownStarted`
- `CleanShutdownComplete`

### Game-scope terminal / edge-case → Session Frame

These end or prevent a game. They never interfere with active gameplay — they
cut it short or report that something outside the game happened. The session
frame shows them as overlays or toasts:

- `WeTimedOut`
- `OpponentTimedOut`
- `WeSlashedOpponent`
- `OpponentSlashedUs`
- `OpponentSuccessfullyCheated`
- `GameCancelled`
- `GameProposalCancelled`
- `InsufficientBalance`
- `GameError`
- `GameOnChain`
- `OpponentPlayedIllegalMove`

### Gameplay events → Game UI Frame

These are the normal flow of play, routed to the active game UI:

- `GameProposalAccepted`
- `OpponentMoved`
- `GameMessage`

## MVP Simplifications

The WASM layer supports multiple simultaneous games (games are tracked by
`GameID`), but the MVP frontend supports only **one game at a time**. This means:

- The session frame manages a single game UI iframe
- The between-game flow is strictly sequential: hand ends → overlay → propose
  next → accept → new hand starts
- Notification routing is trivial: gameplay events go to the one game iframe

This is a UI simplification, not an architectural limitation. When multiple
simultaneous games are added, the session frame gains a multiplexer (game ID →
iframe mapping) and UI for switching between games. The game UI frame contract
does not change — each game instance still behaves as if it is the only game.
