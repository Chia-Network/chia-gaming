---- MODULE potato_handler ----

EXTENDS Integers, Sequences, FiniteSets, TLC

VARIABLES a, b, ui_actions
RECURSIVE DoGameAction(_)

\* States
StepA == 0
StepB == 1
StepC == 2
StepD == 3
StepE == 4
PostStepE == 5
StepF == 6
PostStepF == 7
Finished == 8
OnChainTransition == 9
OnChainWaitingForUnrollTimeoutOrSpend == 10
OnChainWaitForConditions == 11
OnChainWaitingForUnrollSpend == 12
OnChainWaitingForUnrollConditions == 13
OnChain == 14
Completed == 15
MaxHandshakeState == 16
Error == 1000

\* Channel Handler
ChannelHandlerEnded == 1001

\* Potato states
PotatoPresent == 1
PotatoAbsent == -1
PotatoRequested == 0

\* Messages
HandshakeA == 0
HandshakeB == 1
HandshakeE == 4
HandshakeF == 5
UIStartGames == 6
UIStartGamesError == 7
UIStartGamesLocalError == 107
Nil == 10
NilError == 11
NilLocalError == 111
StartGames == 12
StartGamesError == 13
StartGamesLocalError == 113
Move == 14
MoveError == 15
MoveLocalError == 115
Accept == 16
AcceptError == 17
AcceptLocalError == 117
Shutdown == 18
ShutdownError == 19
ShutdownLocalError == 119

DelayedStart == 20
RedoMove == 21
RedoAccept == 22

RequestPotato == 100
SendPotato == 101

Opponent == 10000

PotatoHandler(state) ==
  [ handshake_state |-> state,
    have_potato |-> PotatoPresent,
    messages |-> << >>,
    channel_initiation_transaction |-> 0,
    channel_puzzle_hash |-> 0,
    channel_transaction_sent |-> 0,
    channel_transaction_completed |-> 0,
    channel_handler |-> -1,
    waiting_to_start |-> 1,
    my_start_queue |-> << >>,
    their_start_queue |-> << >>,
    game_action_queue |-> << >>,
    incoming_messages |-> << >>
  ]

UIActions ==
  [ sent_moves |-> 0 ]

Init ==
  /\ a = PotatoHandler(StepA)
  /\ b = PotatoHandler(StepB)
  /\ ui_actions = UIActions

allvars == << a, b, ui_actions >>

\* Basic accessors
IsErr(v) == v[1] < 0
OkOf(v) == v[2]
Err(p) == << -1, p >>
Ok(p) == << 0, p >>
RvOf(p) == p[1]
Rv(v,p) == << v, p >>

NewState(p,s) == [p EXCEPT !.handshake_state = s]

SendMessage(p,m) == [p EXCEPT !.messages = Append(p.messages, m)]

DropMessage(p) == [p EXCEPT !.messages = Tail(p.messages)]

FirstMessage(p) == p.messages[1]

PotatoState(p,ps) == [p EXCEPT !.have_potato = ps]

SetChannelHandler(p, ch) == [p EXCEPT !.channel_handler = ch + 0]

FirstGameActionQueue(p) == p.game_action_queue[1]

DropGameActionQueue(p) == [p EXCEPT !.game_action_queue = Tail(p.game_action_queue)]

FirstMyStartQueue(p) == p.my_start_queue[1]

DropMyStartQueue(p) == [p EXCEPT !.my_start_queue = Tail(p.my_start_queue)]

AppendMyStartQueue(p,s) == [p EXCEPT !.my_start_queue = Append(p.my_start_queue, s)]

DropTheirStartQueue(p) == [p EXCEPT !.their_start_queue = Tail(p.their_start_queue)]

AppendTheirStartQueue(p,s) == [p EXCEPT !.their_start_queue = Append(p.their_start_queue, s)]

AppendIncoming(p,m) == [p EXCEPT !.incoming_messages = Append(p.incoming_messages, m)]

DropIncomingMessage(p) == [p EXCEPT !.incoming_messages = Tail(p.incoming_messages)]

\* Err
ChannelHandler(p) ==
  IF p.channel_handler < 0 THEN
    Err(0)
  ELSE
    Ok(p.channel_handler)

SendPotatoHandlerCommand(p, ch, msg) ==
  SendMessage(p, msg)

SendChannelHandlerCommand(p, ch, msg) ==
  IF msg > 100 THEN
    Err(ch)
  ELSE
    Ok(SendPotatoHandlerCommand(SetChannelHandler(p, ch), ch, msg))

SendPotatoStartGame(p, ch, msg) == SendChannelHandlerCommand(p, ch, msg)
  
SendPotatoMove(p, ch, msg) == SendChannelHandlerCommand(p, ch, msg)

SendPotatoAccept(p, ch, msg) == SendChannelHandlerCommand(p, ch, msg)

SendPotatoCleanShutdown(p, ch, msg) ==
  LET p1 == SendChannelHandlerCommand(p, ch, msg) IN
  IF IsErr(p1) THEN
    p1
  ELSE
    Ok(SetChannelHandler(OkOf(p1), ChannelHandlerEnded))

ReceivedChannelHandlerCommand(ch, msg) ==
  IF msg % 2 = 1 THEN
    Err(ch)
  ELSE
    Ok(ch + 1)

ReceivedPotatoStartGame(ch, msg) == ReceivedChannelHandlerCommand(ch, msg)
ReceivedEmptyPotato(ch, msg) == ReceivedChannelHandlerCommand(ch, msg)
ReceivedPotatoMove(ch, msg) == ReceivedChannelHandlerCommand(ch, msg)
ReceivedPotatoAccept(ch, msg) == ReceivedChannelHandlerCommand(ch, msg)
ReceivedPotatoCleanShutdown(ch, msg) == ReceivedChannelHandlerCommand(ch, msg)

\* Communication with outside during handshake
AskForChannelInitTransaction(p) == [p EXCEPT !.channel_puzzle_hash = 1]

ReplyChannelInitTransaction(p) ==
  [p EXCEPT !.channel_initiation_transaction = 1, !.channel_puzzle_hash = 2]

ReceivedChannelOffer(p) == [p EXCEPT !.channel_transaction_sent = 1]

EnqueueGameAction(p,act) ==
  [p EXCEPT !.game_action_queue = Append(p.game_action_queue, act)]

DropGameAction(p) ==
  [p EXCEPT !.game_action_queue = Tail(p.game_action_queue)]

FirstGameAction(p) ==
  p.game_action_queue[1]

NewChannelHandler(p) == [p EXCEPT !.channel_handler = 0]

\* potato_handler/mod.rs:265
Start(p) ==
  SendMessage(NewState(p, StepC), HandshakeA)

\* potato_handler/mod.rs:567
\* Return ( new_game, new_potato_handler )
HavePotatoStartGame(p) ==
  IF Len(p.their_start_queue) > 0 THEN
    LET ch == ChannelHandler(p) IN
    IF IsErr(ch) THEN
      Err(p)
    ELSE
      LET ch1 == OkOf(ch) IN
      LET ch2 == ReceivedPotatoStartGame(ch1, StartGames) IN
      IF IsErr(ch2) THEN
        Err(p)
      ELSE
        Ok(DropTheirStartQueue(SetChannelHandler(p, OkOf(ch2))))
  ELSE IF Len(p.my_start_queue) > 0 THEN
    LET desc == FirstMyStartQueue(p) IN
    LET p2 == DropMyStartQueue(p) IN
    LET ch == ChannelHandler(p2) IN
    IF IsErr(ch) THEN
      Err(p2)
    ELSE
      Ok(SendMessage(p2, UIStartGames))
  ELSE
    Ok(p)

\* potato_handler/mod.rs:598
\* Return << -1..1, new_potato_handler >>
HavePotatoMove(p) ==
  IF Len(p.game_action_queue) > 0 THEN
    LET game_action == FirstGameActionQueue(p) IN
    LET p1 == DropGameActionQueue(p) IN
    IF game_action = Move \/ game_action = MoveError THEN
      LET ch == ChannelHandler(p1) IN
      IF IsErr(ch) THEN
        Err(p1)
      ELSE
        LET p2 == SendPotatoMove(p1, OkOf(ch), game_action) IN
        LET p3 == PotatoState(OkOf(p2), PotatoAbsent) IN
        Rv(1, p3)
    ELSE IF game_action = RedoMove THEN
      Err(p1)
    ELSE IF game_action = RedoAccept THEN
      Err(p1)
    ELSE IF game_action = Accept \/ game_action = AcceptError THEN
      LET ch == ChannelHandler(p1) IN
      IF IsErr(ch) THEN
        Err(p1)
      ELSE
        LET p2 == SendPotatoAccept(p1, OkOf(ch), game_action) IN
        IF IsErr(p2) THEN
          p2
        ELSE
          LET p3 == PotatoState(OkOf(p2), PotatoAbsent) IN
          Rv(1, p3)
    ELSE IF game_action = Shutdown \/ game_action = ShutdownError THEN
      LET ch == ChannelHandler(p1) IN
      IF IsErr(ch) THEN
        Err(p1)
      ELSE
        LET p2 == SendPotatoCleanShutdown(p1, OkOf(ch), game_action) IN
        LET p3 == SendMessage(OkOf(p2), game_action) IN
        Rv(1, NewState(p3, OnChainWaitingForUnrollSpend))
    ELSE IF game_action = UIStartGames THEN
      Rv(1, p1)
    ELSE IF game_action = RequestPotato THEN
      IF p1.have_potato = PotatoAbsent THEN
        Rv(1, SendMessage(p1, game_action))
      ELSE
        Rv(1, p1)
    ELSE IF game_action = SendPotato THEN
      LET ch == ChannelHandler(p1) IN
      IF IsErr(ch) THEN
        Err(p1)
      ELSE
        LET p2 == SendPotatoMove(p1, OkOf(ch), Nil) IN
        LET p3 == PotatoState(OkOf(p2), PotatoAbsent) IN
        Rv(1, p3)
    ELSE
      \* Illegal requested action
      Rv(1, NewState(p1, Error + game_action))
  ELSE
    Rv(0, p)

\* potato_handler/mod.rs:300
\* Internally updates information that isn't part of this model.
UpdateChannelCoinAfterReceive(p) ==
  LET p0 == PotatoState(p, PotatoPresent) IN
  LET p1 == HavePotatoStartGame(p0) IN
  IF IsErr(p1) THEN
    p1
  ELSE
    LET p2 == HavePotatoMove(OkOf(p1)) IN
    IF IsErr(p2) THEN
      p2
    ELSE
      LET ch == ChannelHandler(OkOf(p2)) IN
      IF IsErr(ch) THEN
        p2
      ELSE
        Ok(SetChannelHandler(OkOf(p2), OkOf(ch)))

\* potato_handler/mod.rs:346
PassOnChannelHandlerMessage(p0,msg) ==
  LET p == PotatoState(p0, PotatoPresent) IN
  LET ch == ChannelHandler(p) IN
  IF IsErr(ch) THEN
    Err(p)
  ELSE
    LET ch1 == OkOf(ch) IN
    IF msg = Nil \/ msg = NilError THEN
      LET ch2 == ReceivedEmptyPotato(ch1, msg) IN
      IF IsErr(ch2) THEN
        Err(p)
      ELSE
        LET p1 == SetChannelHandler(p, OkOf(ch2)) IN
        UpdateChannelCoinAfterReceive(p1)
    ELSE IF msg = StartGames \/ msg = StartGamesError THEN
      LET ch2 == ReceivedPotatoStartGame(ch1, msg) IN
      IF IsErr(ch2) THEN
        Err(p)
      ELSE
        LET p1 == SetChannelHandler(p, OkOf(ch)) IN
        UpdateChannelCoinAfterReceive(p1)
    ELSE IF msg = Move \/ msg = MoveError THEN
      LET ch2 == ReceivedPotatoMove(ch1, msg) IN
      IF IsErr(ch2) THEN
        Err(p)
      ELSE
        LET p1 == SetChannelHandler(p, OkOf(ch)) IN
        UpdateChannelCoinAfterReceive(p1)
    ELSE IF msg = Accept \/ msg = AcceptError THEN
      LET ch2 == ReceivedPotatoAccept(ch1, msg) IN
      IF IsErr(ch2) THEN
        Err(p)
      ELSE
        LET p1 == SetChannelHandler(p, OkOf(ch)) IN
        UpdateChannelCoinAfterReceive(p1)
    ELSE IF msg = Shutdown \/ msg = ShutdownError THEN
      LET ch2 == ReceivedPotatoCleanShutdown(ch1, msg) IN
      IF IsErr(ch2) THEN
        Err(p)
      ELSE
        Ok(NewState(SetChannelHandler(p, ChannelHandlerEnded), OnChainWaitingForUnrollSpend))
    ELSE
      Err(p)

TryCompleteStepE(p) ==
  IF p.handshake_state = PostStepE /\ p.channel_initiation_transaction > 0 THEN
    Ok(NewState(SendMessage(p,HandshakeE),Finished))
  ELSE
    Ok(p)

TryCompleteStepF(p) ==
  IF p.waiting_to_start > 0 THEN
    Ok(p)
  ELSE IF p.handshake_state = PostStepF /\ p.channel_transaction_completed > 0 THEN
    Ok(NewState(SendMessage(p,HandshakeF),Finished))
  ELSE
    Ok(p)

ChannelHandlerMessage(p,act) ==
  LET ch == ChannelHandler(p) IN
  IF IsErr(ch) THEN
    Err(p)
  ELSE
    LET ch1 == OkOf(ch) IN
    IF act = StartGamesError \/ act = MoveError \/ act = AcceptError \/ act = ShutdownError THEN
      Err(p)
    ELSE
      Ok(SendMessage(SetChannelHandler(p, ch1 + 1), act))

SendPotatoRequestIfNeeded(p) ==
  IF p.have_potato = PotatoPresent THEN
    Rv(1, p)
  ELSE IF p.have_potato = PotatoAbsent THEN
    LET p1 == EnqueueGameAction(PotatoState(p, PotatoRequested), RequestPotato) IN
    Rv(1, p1)
  ELSE IF p.have_potato = PotatoRequested /\ Len(p.game_action_queue) > 0 /\ p.game_action_queue[1] = RequestPotato THEN
    Rv(1, p)
  ELSE IF p.handshake_state = Finished /\ p.have_potato = PotatoPresent /\ Len(p.game_action_queue) > 0 /\ p.game_action_queue[1] = SendPotato THEN
    Rv(1, p)
  ELSE
    Rv(0, p)

\* potato_handler/mod.rs:1461
DoGameAction(p) ==
  LET p1 == SendPotatoRequestIfNeeded(p) IN
  IF RvOf(p1) > 0 THEN
    LET p2 == HavePotatoMove(OkOf(p1)) IN
    IF IsErr(p2) THEN
      p2
    ELSE IF RvOf(p2) > 0 THEN
      LET p3 == DoGameAction(OkOf(p2)) IN
      IF IsErr(p3) THEN
        p3
      ELSE IF RvOf(p3) > 0 THEN
        DoGameAction(OkOf(p3))
      ELSE
        p3
    ELSE
      p2
  ELSE
    p1

RehydrateGames(g) == g - UIStartGames + StartGames

\* potato_handler/mod.rs:836
ReceivedGameStart(p, g) ==
  IF Len(p.their_start_queue) = 0 THEN
    Err(p)
  ELSE
    LET ch == ChannelHandler(p) IN
    IF IsErr(ch) THEN
      Err(p)
    ELSE
      LET ch1 == OkOf(ch) IN
      LET ch2 == ReceivedPotatoStartGame(ch1, RehydrateGames(g)) IN
      IF IsErr(ch2) THEN
        Err(p)
      ELSE
        LET ch3 == OkOf(ch2) IN
        UpdateChannelCoinAfterReceive(SetChannelHandler(p, ch3))

\* potato_handler/mod.rs:867
ReceivedMessage(p,m) ==
  DoGameAction(AppendIncoming(p, m))

HandleReceivedMessage1(p,m) ==
  IF p.handshake_state = StepB /\ m = HandshakeA THEN
    Ok(SendMessage(NewState(NewChannelHandler(p), StepD), HandshakeB))
  ELSE IF p.handshake_state = StepC /\ m = HandshakeB THEN
    Ok(SendMessage(NewState(AskForChannelInitTransaction(NewChannelHandler(p)), StepE), Nil))
  ELSE IF p.handshake_state = StepD THEN
    Ok(SendMessage(NewState(p, StepF), Nil))
  ELSE IF p.handshake_state = StepE THEN
    TryCompleteStepE(NewState(p, PostStepE))
  ELSE IF p.handshake_state = StepF THEN
    TryCompleteStepF(ReceivedChannelOffer(NewState(PotatoState(p, PotatoAbsent), PostStepF)))
  ELSE IF p.handshake_state # Finished /\ (m = UIStartGames \/ m = UIStartGamesError) THEN
    Ok(EnqueueGameAction(p, m))
  ELSE IF p.handshake_state = Finished THEN
    IF m = HandshakeF THEN
      Ok(p)
    ELSE IF m = RequestPotato THEN
      DoGameAction(EnqueueGameAction(p, SendPotato))
    ELSE IF m = UIStartGames \/ m = UIStartGamesError THEN
      ReceivedGameStart(p, m)
    ELSE
      PassOnChannelHandlerMessage(p,m)
  ELSE
    LET HandshakeActions == SelectSeq(p.incoming_messages, LAMBDA x: x <= HandshakeF) IN
    LET NewQueue == SelectSeq(p.incoming_messages, LAMBDA x: x > HandshakeF) IN
    Ok([p EXCEPT !.incoming_messages = HandshakeActions \o << m >> \o NewQueue])    

HandleReceivedMessage(p) ==
  IF Len(p.incoming_messages) > 0 THEN
    LET m == p.incoming_messages[1] IN
    LET p1 == DropIncomingMessage(p) IN
    LET p2 == HandleReceivedMessage1(p1, m) IN
    IF IsErr(p2) THEN
      p2
    ELSE
      DoGameAction(OkOf(p2))
  ELSE
    Ok(p)

\* potato_handler/mod.rs:1835
CoinCreated(p) ==
  IF p.handshake_state = PostStepF THEN
    LET p1 == [p EXCEPT !.channel_transaction_completed = 1, !.channel_transaction_sent = 2, !.waiting_to_start = 0] IN
    TryCompleteStepF(p1)
  ELSE
    Ok(p)

\* FromLocalUI

\* potato_handler/mod.rs:1704
FLUI_StartGames(p, i_initiated, s) ==
  IF i_initiated = 0 THEN
    AppendTheirStartQueue(p, s)
  ELSE
    IF p.handshake_state # Finished THEN
      p \* error
    ELSE
      LET p1 == AppendMyStartQueue(p, s) IN
      LET p2 == SendPotatoRequestIfNeeded(p1) IN
      IF RvOf(p2) > 0 THEN
        OkOf(HavePotatoStartGame(OkOf(p2)))
      ELSE
        OkOf(p2)

FLUI_MakeMove(p, act) ==
  LET p1 == EnqueueGameAction(p, act) IN
  OkOf(DoGameAction(p1))

FLUI_Accept(p, act) ==
  LET p1 == EnqueueGameAction(p, act) IN
  OkOf(DoGameAction(p1))

FLUI_Shutdown(p, act) ==
  LET p1 == EnqueueGameAction(p, act) IN
  OkOf(DoGameAction(p1))

StartA ==
  /\ a.handshake_state = StepA
  /\ a' = Start(a) /\ UNCHANGED << b, ui_actions >>

Active(p) == p.channel_handler < ChannelHandlerEnded

ReceivedMessageA ==
  /\ Active(a)
  /\ Len(b.messages) > 0
  /\ Len(a.incoming_messages) = 0
  /\ b' = DropMessage(b)
  /\ a' = OkOf(ReceivedMessage(a, FirstMessage(b)))
  /\ UNCHANGED << ui_actions >>

ReceivedMessageB ==
  /\ Active(b)
  /\ Len(a.messages) > 0
  /\ Len(b.incoming_messages) = 0
  /\ a' = DropMessage(a)
  /\ b' = OkOf(ReceivedMessage(b, FirstMessage(a)))
  /\ UNCHANGED << ui_actions >>

HandleInboundQueueA ==
  /\ Active(a)
  /\ Len(a.incoming_messages) > 0
  /\ a' = OkOf(HandleReceivedMessage(a))
  /\ UNCHANGED << b, ui_actions >>

HandleInboundQueueB ==
  /\ Active(b)
  /\ Len(b.incoming_messages) > 0
  /\ b' = OkOf(HandleReceivedMessage(b))
  /\ UNCHANGED << a, ui_actions >>

ChannelPuzzleHashA ==
  /\ a.channel_puzzle_hash = 1
  /\ a' = OkOf(TryCompleteStepE(ReplyChannelInitTransaction(a)))
  /\ UNCHANGED << b, ui_actions >>

ChannelPuzzleHashB ==
  /\ b.channel_puzzle_hash = 1
  /\ b' = OkOf(TryCompleteStepE(ReplyChannelInitTransaction(b)))
  /\ UNCHANGED << a, ui_actions >>

ChannelTransactionA ==
  /\ a.channel_transaction_sent = 1
  /\ a' = OkOf(CoinCreated(a))
  /\ UNCHANGED << b, ui_actions >>

ChannelTransactionB ==
  /\ b.channel_transaction_sent = 1
  /\ b' = OkOf(CoinCreated(b))
  /\ UNCHANGED << a, ui_actions >>

StartGamesA ==
  /\ ui_actions.sent_moves < 1
  /\ a.handshake_state >= Finished
  /\ a.handshake_state < MaxHandshakeState
  /\ a' = FLUI_StartGames(a, 1, StartGames)
  /\ b' = FLUI_StartGames(b, 0, StartGames)
  /\ ui_actions' = [ui_actions EXCEPT !.sent_moves = 1]

GameMoveA ==
  /\ ui_actions.sent_moves >= 1 
  /\ ui_actions.sent_moves < 7
  /\ a.handshake_state >= Finished
  /\ a.handshake_state < MaxHandshakeState
  /\ a' = FLUI_MakeMove(a, Move)
  /\ ui_actions' = [ui_actions EXCEPT !.sent_moves = ui_actions.sent_moves + 1]
  /\ UNCHANGED << b >>

GameMoveB ==
  /\ ui_actions.sent_moves >= 1 
  /\ ui_actions.sent_moves < 7
  /\ b.handshake_state >= Finished
  /\ b.handshake_state < MaxHandshakeState
  /\ b' = FLUI_MakeMove(b, Move)
  /\ ui_actions' = [ui_actions EXCEPT !.sent_moves = ui_actions.sent_moves + 1]
  /\ UNCHANGED << a >>

GameAcceptA ==
  /\ ui_actions.sent_moves = 7
  /\ a.handshake_state >= Finished
  /\ a.handshake_state < MaxHandshakeState
  /\ a' = FLUI_Accept(a, Accept)
  /\ ui_actions' = [ui_actions EXCEPT !.sent_moves = ui_actions.sent_moves + 1]
  /\ UNCHANGED << b >>

GameAcceptB ==
  /\ ui_actions.sent_moves = 8
  /\ b.handshake_state >= Finished
  /\ b.handshake_state < MaxHandshakeState
  /\ b' = FLUI_Accept(b, Accept)
  /\ ui_actions' = [ui_actions EXCEPT !.sent_moves = ui_actions.sent_moves + 1]
  /\ UNCHANGED << a >>

ShutdownA ==
  /\ ui_actions.sent_moves = 9
  /\ a.handshake_state >= Finished
  /\ a.handshake_state < MaxHandshakeState
  /\ a' = FLUI_Shutdown(a, Shutdown)
  /\ ui_actions' = [ui_actions EXCEPT !.sent_moves = ui_actions.sent_moves + 1]
  /\ UNCHANGED << b >>

ShutdownB ==
  /\ ui_actions.sent_moves = 10
  /\ b.handshake_state >= Finished
  /\ b.handshake_state < MaxHandshakeState
  /\ b' = FLUI_Shutdown(b, Shutdown)
  /\ ui_actions' = [ui_actions EXCEPT !.sent_moves = ui_actions.sent_moves + 1]
  /\ UNCHANGED << a >>

SideShutDown(p) ==
  /\ p.channel_handler >= ChannelHandlerEnded

BothShutDown == SideShutDown(a) /\ SideShutDown(b) /\ UNCHANGED allvars

Termination == <>(SideShutDown(a) /\ SideShutDown(b))

Next ==
  \/ StartA
  \/ ReceivedMessageA
  \/ ReceivedMessageB
  \/ HandleInboundQueueA
  \/ HandleInboundQueueB
  \/ ChannelPuzzleHashA
  \/ ChannelPuzzleHashB
  \/ ChannelTransactionA
  \/ ChannelTransactionB
  \/ StartGamesA
  \/ GameMoveA
  \/ GameMoveB
  \/ GameAcceptA
  \/ GameAcceptB
  \/ ShutdownA
  \/ ShutdownB
  \/ BothShutDown

Spec ==
  /\ Init
  /\ [][Next]_allvars

PHInvariant(p) ==
  /\ p.handshake_state >= StepA
  /\ p.handshake_state < MaxHandshakeState
  /\ p.have_potato >= PotatoAbsent
  /\ p.have_potato <= PotatoPresent
  /\ Len(p.messages) < 20
  /\ Len(p.incoming_messages) < 20
  /\ Len(p.game_action_queue) < 20

Inv ==
  /\ PHInvariant(a)
  /\ PHInvariant(b)

====
