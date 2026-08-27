use std::collections::BTreeMap;
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::channel_state::game_handler::PreparedMove;
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{
    ChannelEnv, ChannelPrivateKeys, ReadableMove, StateUpdateSignatures,
};
#[cfg(test)]
use crate::common::types::Program;
use crate::common::types::{
    Aggsig, Amount, CoinSpend, Error, GameID, GameType, Hash, ProgramRef, PuzzleHash, Timeout,
};
use crate::referee::types::GameMoveDetails;
use crate::session_phases::effects::Effect;
use crate::session_phases::handshake::{
    HandshakePayloadB, HandshakePayloadC, HandshakePayloadD, HandshakePayloadE, HandshakePayloadF,
};
use crate::session_phases::proposal::GameProposal;

pub use crate::session_phases::wallet_traits::{
    ChannelFundingWallet, SpendWalletReceiver, WalletSpendInterface,
};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireGameSpec {
    pub game_id: GameID,
    pub player_a_contribution: Amount,
    pub player_b_contribution: Amount,
    pub player_a_goes_first: bool,
    pub initial_validation_program_hash: Hash,
    pub initial_validation_info_hash: Hash,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_mover_share: Amount,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireProposalGroup {
    pub start: GameProposal,
    pub members: Vec<WireGameSpec>,
}

#[cfg(test)]
mod wire_proposal_tests {
    use super::*;
    use crate::session_phases::proposal::ProposalParameters;

    #[test]
    fn serialized_wire_game_omits_factory_local_raw_fields() {
        let member = WireGameSpec {
            game_id: GameID(7),
            player_a_contribution: Amount::new(4),
            player_b_contribution: Amount::new(6),
            player_a_goes_first: true,
            initial_validation_program_hash: Hash::default(),
            initial_validation_info_hash: Hash::default(),
            initial_move: vec![],
            initial_max_move_size: 32,
            initial_mover_share: Amount::new(4),
        };
        let wire = WireProposalGroup {
            start: GameProposal {
                player_a_contribution: Amount::new(4),
                player_b_contribution: Amount::new(6),
                sender_is_player_a: true,
                game_type: GameType::from_hash(Hash::default()),
                timeout: Timeout::new(15),
                parameters: ProposalParameters::Null,
            },
            members: vec![member.clone()],
        };

        let encoded_member = bencodex::to_vec(&member).expect("serialize wire member");
        let value: crate::protocol_pretty::BencodexValue =
            bencodex::from_slice(&encoded_member).expect("decode wire member fields");
        let crate::protocol_pretty::BencodexValue::Map(fields) = value else {
            panic!("wire member did not serialize as a map");
        };
        let keys: Vec<&str> = fields
            .iter()
            .map(|(key, _)| match key {
                crate::protocol_pretty::BencodexValue::Text(key) => key.as_str(),
                other => panic!("wire member has non-text key {other:?}"),
            })
            .collect();
        for absent in [
            "amount",
            "my_turn_handler",
            "their_turn_handler",
            "initial_validation_program",
            "initial_state",
        ] {
            assert!(
                !keys.contains(&absent),
                "serialized proposal unexpectedly contains {absent}"
            );
        }
        for retained in [
            "player_a_contribution",
            "initial_validation_program_hash",
            "initial_validation_info_hash",
        ] {
            assert!(
                keys.contains(&retained),
                "serialized proposal is missing {retained}"
            );
        }

        let encoded_group = bencodex::to_vec(&wire).expect("serialize wire group");
        let value: crate::protocol_pretty::BencodexValue =
            bencodex::from_slice(&encoded_group).expect("decode wire group fields");
        let crate::protocol_pretty::BencodexValue::Map(fields) = value else {
            panic!("wire group did not serialize as a map");
        };
        assert!(!fields.iter().any(|(key, _)| {
            matches!(key, crate::protocol_pretty::BencodexValue::Text(key) if key == "group_id")
        }));
    }
}

pub trait ToLocalUI {
    fn notification(
        &mut self,
        notification: &crate::session_phases::effects::GameNotification,
    ) -> Result<(), Error>;

    fn log(&mut self, _line: &str) -> Result<(), Error> {
        Ok(())
    }
}

pub trait FromLocalUI {
    fn propose_games(
        &mut self,
        env: &mut ChannelEnv<'_>,
        games: &[GameProposal],
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error>;

    fn accept_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn cancel_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn make_move(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error>;

    fn accept_settlement(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn shut_down(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error>;
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum BatchAction {
    ProposeGroup(WireProposalGroup),
    AcceptProposalGroup(GameID),
    CancelProposalGroup(GameID),
    Move(GameID, GameMoveDetails),
    #[serde(rename = "AcceptSettlement")]
    AcceptSettlement(GameID, Amount),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum PeerMessage {
    HandshakeA(HandshakePayloadB),
    HandshakeB(HandshakePayloadB),
    HandshakeC(HandshakePayloadC),
    HandshakeD(HandshakePayloadD),
    HandshakeE(HandshakePayloadE),
    HandshakeF(HandshakePayloadF),

    Batch {
        actions: Vec<BatchAction>,
        signatures: StateUpdateSignatures,
        clean_shutdown: Option<Box<(Aggsig, ProgramRef)>>,
    },
    CleanShutdownComplete(CoinSpend),
    RequestPotato(()),
    Message(GameID, Vec<u8>),
}

impl PeerMessage {
    pub fn is_handshake(&self) -> bool {
        matches!(
            self,
            PeerMessage::HandshakeA(_)
                | PeerMessage::HandshakeB(_)
                | PeerMessage::HandshakeC(_)
                | PeerMessage::HandshakeD(_)
                | PeerMessage::HandshakeE(_)
                | PeerMessage::HandshakeF(_)
        )
    }
}

pub trait PacketSender {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PotatoState {
    Absent,
    Requested,
    Present,
}

#[derive(Clone, Serialize, Deserialize)]
pub enum GameAction {
    Move(GameID, PreparedMove),
    #[serde(rename = "AcceptSettlement")]
    AcceptSettlement(GameID),
    CleanShutdown,
    QueuedProposalGroup(Vec<Rc<GameStartInfo>>, WireProposalGroup),
    QueuedAcceptProposalGroup(GameID),
    QueuedCancelProposalGroup(GameID),
    QueuedCancelProposalGroupSilently(GameID),
    Cheat(GameID, Amount, Hash),
    #[cfg(test)]
    ForcedSelfAccept(GameID),
}

pub(crate) fn validate_new_move_action<'a>(
    game_id: &GameID,
    authority: Option<bool>,
    queued_actions: impl IntoIterator<Item = &'a GameAction>,
    pending: bool,
) -> Result<(), Error> {
    let has_queued_move = queued_actions
        .into_iter()
        .any(|action| matches!(action, GameAction::Move(queued_id, ..) if queued_id == game_id));
    game_assert!(
        authority == Some(true),
        "make_move called when game authority does not give us the turn"
    );
    game_assert!(
        !has_queued_move,
        "make_move called while a move for this game is already queued"
    );
    game_assert!(
        !pending,
        "make_move called while a move for this game is pending"
    );
    Ok(())
}

impl std::fmt::Debug for GameAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        match self {
            GameAction::Move(gi, prepared) => write!(formatter, "Move({gi:?},{prepared:?})"),
            GameAction::AcceptSettlement(gi) => write!(formatter, "AcceptSettlement({gi:?})"),
            GameAction::CleanShutdown => write!(formatter, "CleanShutdown"),
            GameAction::QueuedProposalGroup(_, _) => write!(formatter, "QueuedProposalGroup(..)"),
            GameAction::QueuedAcceptProposalGroup(gi) => {
                write!(formatter, "QueuedAcceptProposalGroup({gi:?})")
            }
            GameAction::QueuedCancelProposalGroup(gi) => {
                write!(formatter, "QueuedCancelProposalGroup({gi:?})")
            }
            GameAction::QueuedCancelProposalGroupSilently(gi) => {
                write!(formatter, "QueuedCancelProposalGroupSilently({gi:?})")
            }
            GameAction::Cheat(gi, ms, _) => write!(formatter, "Cheat({gi:?},{ms:?})"),
            #[cfg(test)]
            GameAction::ForcedSelfAccept(gi) => write!(formatter, "ForcedSelfAccept({gi:?})"),
        }
    }
}

#[cfg(test)]
mod move_authority_tests {
    use super::*;
    use crate::channel_state::game_handler::PreparedMove;
    use crate::channel_state::types::StateUpdateProgram;
    use crate::common::types::{AllocEncoder, Amount};
    use std::collections::VecDeque;

    fn queued_move_with_bytes(game_id: GameID, move_bytes: Vec<u8>) -> GameAction {
        let mut allocator = AllocEncoder::new();
        let validator = StateUpdateProgram::new(
            &mut allocator,
            "queued test",
            Rc::new(Program::from_bytes(&[0x80])),
        );
        GameAction::Move(
            game_id,
            PreparedMove {
                move_bytes,
                outgoing_move_state_update_program: validator.clone(),
                incoming_move_state_update_program: validator,
                max_move_size: 0,
                mover_share: Amount::default(),
                waiting_handler: None,
                message_parser: None,
            },
        )
    }

    fn queued_move(game_id: GameID) -> GameAction {
        queued_move_with_bytes(game_id, vec![])
    }

    #[test]
    #[should_panic(expected = "already queued")]
    fn second_move_for_same_game_while_queued_fails_loudly() {
        let game_id = GameID(7);
        let queue = [queued_move(game_id)];
        let _ = validate_new_move_action(&game_id, Some(true), &queue, false);
    }

    #[test]
    #[should_panic(expected = "pending")]
    fn second_move_for_same_game_while_pending_fails_loudly() {
        let _ = validate_new_move_action(&GameID(7), Some(true), &[], true);
    }

    #[test]
    #[should_panic(expected = "does not give us the turn")]
    fn move_when_game_authority_says_their_turn_fails_loudly() {
        let _ = validate_new_move_action(&GameID(7), Some(false), &[], false);
    }

    #[test]
    fn prepared_move_queue_round_trips_multiple_game_ids_in_order() {
        let queue = VecDeque::from([
            queued_move_with_bytes(GameID(7), b"first".to_vec()),
            queued_move_with_bytes(GameID(9), b"second".to_vec()),
        ]);

        let encoded = bencodex::to_vec(&queue).expect("serialize prepared move queue");
        assert!(!encoded.windows(8).any(|window| window == b"readable"));
        assert!(!encoded.windows(7).any(|window| window == b"entropy"));

        let restored: VecDeque<GameAction> =
            bencodex::from_slice(&encoded).expect("deserialize prepared move queue");
        let restored: Vec<_> = restored
            .into_iter()
            .map(|action| match action {
                GameAction::Move(id, prepared) => (id, prepared.move_bytes),
                other => panic!("unexpected restored action: {other:?}"),
            })
            .collect();
        assert_eq!(
            restored,
            vec![
                (GameID(7), b"first".to_vec()),
                (GameID(9), b"second".to_vec())
            ]
        );
    }

    #[test]
    fn prepared_moves_for_different_games_may_coexist() {
        let queue = [queued_move(GameID(7))];
        validate_new_move_action(&GameID(9), Some(true), &queue, false)
            .expect("different game ids may each have one prepared move");
    }
}

#[derive(Serialize, Deserialize)]
pub struct OffChainPhaseInit {
    pub have_potato: bool,
    pub private_keys: ChannelPrivateKeys,
    pub game_types: BTreeMap<GameType, ProgramRef>,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
    pub reward_puzzle_hash: PuzzleHash,
}
