PlayingCard
--

    {"id":"test",
     "index":3,
     "cardValue":[2,2],
     "selected":true,
     "setSelection":"*function",
     "iAmPlayer":true
    }

GameEndPlayer
--

    {"iStarted":true, "playerNumber":1, "outcome":{
        "alice_discards": 85,
        "bob_discards": 170,
        "alice_selects": 240,
        "bob_selects": 15,
        "alice_hand_value": [1,1,1,1,1,3,4,5,6,8],
        "bob_hand_value": [2,2,1,3,5,9],
        "win_direction": -1,
        "my_win_outcome": "win",
        "alice_cards": [[3,2],[3,3],[5,1],[5,4],[13,3]],
        "bob_cards": [[3,1],[4,1],[5,1],[6,2],[8,3]],
        "alice_final_hand": [[3,2],[3,3],[5,1],[5,4],[10,1],[10,1],[12,4],[13,3]],
        "bob_final_hand": [[3,1],[4,1],[5,1],[6,2],[8,3],[9,1],[9,2],[10,3]],
        "alice_used_cards": [[3,2],[3,3],[5,1],[5,4],[13,3]],
        "bob_used_cards": [[3,1],[4,1],[5,1],[6,2],[8,3]]
    }}

OpponentSection
--

    {"playerNumber": 1, "opponentHand": [[3,2],[3,3],[5,1],[5,4],[10,1],[10,1],[12,4],[13,3]]}

WaitingScreen
--

     {"stateName":"Starting up", "messages":["loading calpoker"]}

QRCodeModal
--

     {"open": true, "uri": "wc:test-url", "onClose":"*function"}

PlayerSection
--

    {"playerNumber": 1,
     "playerHand": [[3,2],[3,3],[5,1],[5,4],[10,1],[10,1],[12,4],[13,3]],
     "isPlayerTurn": true,
     "moveNumber": 1,
     "handleMakeMove": "*function",
     "cardSelections": 3,
     "setCardSelections": "*function"
    }

GameLog
--

    {"log":[
        {"topLineOutcome": "lose",
         "myHandDescription": {
             "name": "Two pair",
             "rank": true,
             "values": [3,4,14]
         },
         "opponentHandDescription": {
             "name": "Flush",
             "rank": false,
             "values": [3]
         },
         "myHand": [[3,1],[3,3],[4,2],[4,4],[14,1]],
         "opponentHand": [[4,3],[5,3],[6,3],[8,3],[10,3]]
        }
    ]}

Calpoker
--

Running:

    {"iStarted": true, "playerNumber":1,
     "moveNumber": 2,
     "playerHand": [[3,2],[3,3],[5,1],[5,4],[10,1],[10,1],[12,4],[13,3]],
     "opponentHand": [[3,1],[4,1],[5,1],[6,2],[8,3],[9,1],[9,2],[10,3]],
     "isPlayerTurn": true,
     "cardSelections": 3,
     "setCardSelections": "*function",
     "handleMakeMove": "*function",
     "stopPlaying": "*function"
    }

Game end:

    {"iStarted": true, "playerNumber":1,
     "moveNumber": 2, "outcome":{
        "alice_discards": 85,
        "bob_discards": 170,
        "alice_selects": 240,
        "bob_selects": 15,
        "alice_hand_value": [1,1,1,1,1,3,4,5,6,8],
        "bob_hand_value": [2,2,1,3,5,9],
        "win_direction": -1,
        "my_win_outcome": "win",
        "alice_cards": [[3,2],[3,3],[5,1],[5,4],[13,3]],
        "bob_cards": [[3,1],[4,1],[5,1],[6,2],[8,3]],
        "alice_final_hand": [[3,2],[3,3],[5,1],[5,4],[10,1],[10,1],[12,4],[13,3]],
        "bob_final_hand": [[3,1],[4,1],[5,1],[6,2],[8,3],[9,1],[9,2],[10,3]],
        "alice_used_cards": [[3,2],[3,3],[5,1],[5,4],[13,3]],
        "bob_used_cards": [[3,1],[4,1],[5,1],[6,2],[8,3]]
    }}
