# Frontend Architecture Direction

This document describes the target architecture for the frontend JavaScript/TypeScript
code. It is aspirational — the current codebase does not yet match this design. It
serves as a reference for future work.

For the backend/WASM architecture, see `ARCHITECTURE.MD`.

## System-Level View

The system consists of two separate deployable artifacts:

1. **Player App** — A fully static HTML/JS/CSS application. This is the main
   application that players run. It contains the wallet connection, WASM cradle,
   game session logic, and all game UIs. It is served as static files with no
   server-side logic. The only dynamic configuration is a list of tracker URLs.

2. **Tracker** — A separate dynamic service that provides two things: a lobby UI
   for matchmaking (loaded as an iframe inside the player app), and a message
   relay that ferries game messages between peers via socket.io. The tracker is
   third-party code — anyone can run one, and players choose which trackers to
   connect to.

The player app maintains a **tracker list** — a set of tracker URLs that the
user can add to or remove from. This list is persisted locally in the browser
(localStorage), not on any server. The player app may ship with a default tracker
URL, but the user's local list is the source of truth. The UX presents the
tracker list as a set of lobbies the player can connect to.

### Peer Messaging

Currently, all game messages between peers are relayed through the tracker's
socket.io server. Both players connect to the same tracker with a shared token,
and the tracker routes messages between them. This is simple and works well
behind NATs, but it means the tracker must stay connected for the duration of the
session.

A future option is to upgrade to WebRTC for peer-to-peer messaging after the
initial matchmaking. This would remove the tracker as a runtime dependency once
both peers are connected, but adds ICE/STUN/TURN complexity. Game messages are
small and infrequent (a few per hand), so the relay approach is adequate for now.

### Session Persistence

The player app must survive accidental browser closes. Session state is
continuously saved to localStorage so that reloading the page reconnects to the
in-progress session automatically. When both peers reconnect (possibly after one
or both closed their browser), they exchange save IDs through the tracker,
find a matching session, and resume where they left off.

This is always-on — not a feature the user has to opt into. The save
infrastructure (`save.ts`) and the save-exchange protocol in `GameSocket.ts`
already exist but are currently disabled pending testing.

## Player App Internal Architecture

The player app is organized as a set of nested frames with strict containment
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

### Lobby Iframe (Tracker)

The lobby iframe is **untrusted**. It is served by a tracker from the user's
tracker list (see "System-Level View" above). It provides matchmaking UX and can
have whatever visual design and user experience the tracker operator wants.

Its only capability visible to the rest of the application is firing a signal
that triggers a peer connection. The parent window listens for this signal and
ignores everything else from the lobby.

The lobby connection is persistent and always visible (e.g. as a tab). The UX
starts by allowing the user to navigate to a lobby from their tracker list. Both
players connect to the same tracker, and the lobby triggers both of them
connecting to each other — replacing the current manual URL-sharing flow.

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
