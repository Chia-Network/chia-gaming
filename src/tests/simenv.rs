use std::rc::Rc;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvmr::NodePtr;

use clvm_tools_rs::classic::clvm_tools::binutils::{assemble, disassemble};
use clvm_tools_rs::compiler::srcloc::Srcloc;
use clvm_tools_rs::classic::clvm_tools::stages::stage_0::{DefaultProgramRunner, TRunProgram};
use clvm_tools_rs::compiler::clvm::{convert_from_clvm_rs, run};
use clvm_tools_rs::compiler::compiler::DefaultCompilerOpts;
use clvm_tools_rs::compiler::comptypes::CompilerOpts;

use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::types::{AllocEncoder, Amount, CoinString, Error, PrivateKey, PuzzleHash, Hash, SpecificTransactionBundle, TransactionBundle, Sha256tree, Timeout, IntoErr, Node, GameID};
use crate::common::standard_coin::{ChiaIdentity, read_hex_puzzle, get_standard_coin_puzzle, standard_solution_partial, puzzle_for_synthetic_public_key, private_to_public_key};
use crate::channel_handler::game::Game;
use crate::channel_handler::types::{ChannelHandlerEnv, ReadableMove, ValidationProgram, GameStartInfo};
use crate::tests::channel_handler::ChannelHandlerGame;
use crate::tests::game::new_channel_handler_game;
use crate::tests::referee::{make_debug_game_handler, RefereeTest};
use crate::tests::simulator::Simulator;

#[derive(Debug, Clone)]
pub enum GameAction {
    /// Do a timeout
    Timeout(usize),
    /// Move (player, clvm readable move)
    Move(usize, NodePtr),
    /// Fake move:
    FakeMove(usize, NodePtr, Vec<u8>),
    /// Go on chain
    GoOnChain(usize)
}

#[derive(Debug, Clone)]
pub enum GameActionResult {
    MoveResult(NodePtr, Vec<u8>),
    MoveToOnChain,
}

#[derive(Debug, Clone)]
pub enum OnChainState {
    OffChain(CoinString),
    OnChain(Vec<CoinString>),
}

pub struct SimulatorEnvironment<'a, R: Rng> {
    pub env: ChannelHandlerEnv<'a, R>,
    pub on_chain: OnChainState,
    pub identities: [ChiaIdentity; 2],
    pub parties: ChannelHandlerGame,
    pub simulator: Simulator,
}

impl<'a, R: Rng> SimulatorEnvironment<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        game: &Game,
        contributions: &[Amount; 2]
    ) -> Result<Self, Error> {

        // Generate keys and puzzle hashes.
        let my_private_key: PrivateKey = rng.gen();
        let their_private_key: PrivateKey = rng.gen();

        let identities = [
            ChiaIdentity::new(allocator, my_private_key).expect("should generate"),
            ChiaIdentity::new(allocator, their_private_key).expect("should generate")
        ];

        let referee_coin_puzzle = read_hex_puzzle(
            allocator,
            "onchain/referee.hex"
        ).expect("should be readable");
        let referee_coin_puzzle_hash: PuzzleHash = referee_coin_puzzle.sha256tree(allocator);
        let unroll_puzzle = read_hex_puzzle(
            allocator,
            "resources/unroll_puzzle_state_channel_unrolling.hex"
        ).expect("should read");
        let unroll_metapuzzle = read_hex_puzzle(
            allocator,
            "resources/unroll_meta_puzzle.hex"
        ).expect("should read");
        let standard_puzzle = get_standard_coin_puzzle(allocator).expect("should load");
        let mut env = ChannelHandlerEnv {
            allocator: allocator,
            rng: rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            unroll_metapuzzle,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
        };

        let simulator = Simulator::new();
        let (parties, coin) = new_channel_handler_game(
            &simulator,
            &mut env,
            &game,
            &identities,
            contributions.clone(),
        )?;

        Ok(SimulatorEnvironment {
            env,
            identities,
            parties,
            on_chain: OnChainState::OffChain(coin),
            simulator
        })
    }

    // Create a channel coin from the users' input coins giving the new CoinString
    // and the state number.  The result is the coin string of the new coin and
    // conditions to use with the channel handler interface.
    fn spend_channel_coin(
        &mut self,
        state_channel: CoinString,
        unroll_coin_puzzle_hash: &PuzzleHash,
    ) -> Result<(NodePtr, CoinString), Error> {
        let cc_spend = self.parties.get_channel_coin_spend()?;
        let cc_ph = cc_spend.channel_puzzle_reveal.sha256tree(self.env.allocator);
        eprintln!("puzzle hash to spend state channel coin: {cc_ph:?}");
        eprintln!("spend conditions {}",
                  disassemble(self.env.allocator.allocator(), cc_spend.spend.conditions, None));

        let private_key_1 =
            self.parties.player(0).ch.channel_private_key();
        let private_key_2 =
            self.parties.player(1).ch.channel_private_key();
        let aggregate_public_key1 = self.parties.player(0).ch.get_aggregate_channel_public_key();
        let aggregate_public_key2 = self.parties.player(1).ch.get_aggregate_channel_public_key();
        assert_eq!(aggregate_public_key1, aggregate_public_key2);

        eprintln!("parent coin {:?}", state_channel.to_parts());
        let spend1 = standard_solution_partial(
            self.env.allocator,
            &private_key_1,
            &state_channel.to_coin_id(),
            cc_spend.spend.conditions,
            &aggregate_public_key1,
            &self.env.agg_sig_me_additional_data,
            true
        )?;
        eprintln!("party1 predicted sig {:?}", spend1.signature);
        let spend2 = standard_solution_partial(
            self.env.allocator,
            &private_key_2,
            &state_channel.to_coin_id(),
            cc_spend.spend.conditions,
            &aggregate_public_key1,
            &self.env.agg_sig_me_additional_data,
            true
        )?;
        eprintln!("party2 predicted sig {:?}", spend2.signature);
        let signature = spend1.signature.clone() + spend2.signature.clone();
        let predicted_puzzle = puzzle_for_synthetic_public_key(
            self.env.allocator,
            &self.env.standard_puzzle,
            &aggregate_public_key1,
        )?;

        assert_eq!(cc_ph, predicted_puzzle.sha256tree(self.env.allocator));
        assert_eq!(signature, cc_spend.spend.aggsig);

        let spend_of_channel_coin = SpecificTransactionBundle {
            coin: state_channel.clone(),
            bundle: TransactionBundle {
                puzzle: cc_spend.channel_puzzle_reveal.clone(),
                solution: cc_spend.spend.solution,
                signature,
            }
        };

        let included = self.simulator.push_tx(
            self.env.allocator,
            &[spend_of_channel_coin]
        ).into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("failed to spend channel coin {included:?}")));
        }

        self.simulator.farm_block(&self.identities[0].puzzle_hash);

        Ok((cc_spend.spend.conditions, CoinString::from_parts(
            &state_channel.to_coin_id(),
            unroll_coin_puzzle_hash,
            &cc_spend.amount
        )))
    }

    fn do_off_chain_move(&mut self, player: usize, readable: NodePtr) -> Result<GameActionResult, Error> {
        let game_id = self.parties.game_id.clone();
        let move_result =
            self.parties.player(player).ch.send_potato_move(
                &mut self.env,
                &game_id,
                &ReadableMove::from_nodeptr(readable)
            )?;
        // XXX allow verification of ui result and message.
        let (spend, ui_result, message) =
            self.parties.player(player ^ 1).ch.received_potato_move(
                &mut self.env,
                &game_id,
                &move_result
            )?;
        self.parties.update_channel_coin_after_receive(&spend)?;

        Ok(GameActionResult::MoveResult(ui_result, message))
    }

    fn do_unroll_spend_to_games(
        &mut self,
        player: usize,
        player_state: usize,
        unroll_coin: CoinString
    ) -> Result<Vec<CoinString>, Error> {
        let player_ch = &mut self.parties.player(player).ch;
        let pre_unroll_data =
            player_ch.get_unroll_coin_transaction(&mut self.env)?;

        let srcloc = Srcloc::start("*unroll*");
        let runner: Rc<dyn TRunProgram> = Rc::new(DefaultProgramRunner::new());
        let opts: Rc<dyn CompilerOpts> = Rc::new(DefaultCompilerOpts::new("*unroll*"));

        let program = convert_from_clvm_rs(
            self.env.allocator.allocator(),
            srcloc.clone(),
            pre_unroll_data.transaction.puzzle.to_nodeptr()
        ).into_gen()?;
        let args = convert_from_clvm_rs(
            self.env.allocator.allocator(),
            srcloc.clone(),
            pre_unroll_data.transaction.solution
        ).into_gen()?;
        eprintln!("raw args {}", disassemble(self.env.allocator.allocator(), pre_unroll_data.transaction.solution, None));

        eprintln!("unroll program {program}");
        eprintln!("unroll args {args}");
        let puzzle_result = run(
            self.env.allocator.allocator(),
            runner,
            opts.prim_map(),
            program,
            args,
            None,
            None,
        ).into_gen()?;
        eprintln!("puzzle_result: {puzzle_result}");

        self.simulator.farm_block(&self.identities[0].puzzle_hash);

        eprintln!("private key 1: {:?}", self.parties.player(0).ch.unroll_private_key());
        eprintln!("private key 2: {:?}", self.parties.player(1).ch.unroll_private_key());
        eprintln!("doing transaction");
        let included = self.simulator.push_tx(
            self.env.allocator,
            &[SpecificTransactionBundle {
                bundle: pre_unroll_data.transaction.clone(),
                coin: unroll_coin
            }]
        ).into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("could not spend unroll coin for move: {included:?}")));
        }

        todo!();
    }

    fn do_on_chain_move(&mut self, player: usize, readable: NodePtr, game_coins: &[CoinString]) -> Result<GameActionResult, Error> {
        let game_id = self.parties.game_id.clone();
        let player_ch = &mut self.parties.player(player).ch;
        let move_result =
            player_ch.send_potato_move(
                &mut self.env,
                &game_id,
                &ReadableMove::from_nodeptr(readable)
            )?;
        let post_unroll_data =
            player_ch.get_unroll_coin_transaction(&mut self.env)?;
        eprintln!("post_unroll_data {post_unroll_data:?}");
        todo!();
    }

    pub fn perform_action(
        &mut self,
        action: &GameAction,
    ) -> Result<GameActionResult, Error> {
        eprintln!("play move {action:?}");
        match action {
            GameAction::Move(player, readable) => {
                match &self.on_chain {
                    OnChainState::OffChain(coins) => {
                        self.do_off_chain_move(*player, *readable)
                    }
                    OnChainState::OnChain(games) => {
                        // Multiple borrow.
                        self.do_on_chain_move(*player, *readable, &games.clone())
                    }
                }
            }
            GameAction::GoOnChain(player) => {
                let (state_number, unroll_target, my_amount, their_amount) =
                    self.parties.player(*player).ch.get_unroll_target(
                    &mut self.env,
                )?;
                let state_channel_coin =
                    match self.on_chain.clone() {
                        OnChainState::OffChain(coin) => {
                            coin.clone()
                        }
                        _ => {
                            return Err(Error::StrErr("go on chain when on chain".to_string()));
                        }
                    };

                let aggregate_public_key =
                    private_to_public_key(&self.parties.player(0).ch.channel_private_key()) +
                    private_to_public_key(&self.parties.player(1).ch.channel_private_key());
                eprintln!(
                    "going on chain: aggregate public key is: {aggregate_public_key:?}",
                );
                let (channel_coin_conditions, unroll_coin) =
                    self.spend_channel_coin(
                        state_channel_coin,
                        &unroll_target,
                    )?;
                eprintln!("unroll_coin {unroll_coin:?}");
                let game_coins = self.do_unroll_spend_to_games(
                    *player,
                    state_number,
                    unroll_coin
                )?;

                eprintln!(
                    "channel coin conditions {}",
                    disassemble(
                        self.env.allocator.allocator(),
                        channel_coin_conditions,
                        None
                    )
                );

                let channel_spent_result_1 = self.parties.player(*player).ch.channel_coin_spent(
                    &mut self.env,
                    channel_coin_conditions
                )?;
                let channel_spent_result_2 = self.parties.player(*player ^ 1).ch.channel_coin_spent(
                    &mut self.env,
                    channel_coin_conditions
                )?;

                self.on_chain = OnChainState::OnChain(game_coins);
                Ok(GameActionResult::MoveToOnChain)
            }
            _ => {
                todo!();
            }
        }
    }

    pub fn play_game(
        &mut self,
        actions: &[GameAction],
    ) -> Result<Vec<GameActionResult>, Error> {
        let mut results = Vec::new();
        for a in actions.iter() {
            results.push(self.perform_action(a)?);
        }

        Ok(results)
    }
}

#[test]
fn test_sim() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::new();
    let private_key: PrivateKey = rng.gen();
    let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
    eprintln!("identity public key {:?}", identity.public_key);
    s.farm_block(&identity.puzzle_hash);

    let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");
    eprintln!("coin 0 {:?}", coins[0].to_parts());
    eprintln!("coin 0 id {:?}", coins[0].to_coin_id());

    let (_, _, amt) = coins[0].to_parts().unwrap();
    s.spend_coin_to_puzzle_hash(
        &mut allocator,
        &identity,
        &identity.puzzle,
        &coins[0],
        &[(identity.puzzle_hash.clone(), amt.clone())]
    ).expect("should spend");
}

#[test]
fn test_simulator_transfer_coin() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::new();
    let private_key: PrivateKey = rng.gen();
    let identity1 = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
    let pk2: PrivateKey = rng.gen();
    let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");

    s.farm_block(&identity1.puzzle_hash);

    let coins1 = s.get_my_coins(&identity1.puzzle_hash).expect("got coins");
    let coins2_empty = s.get_my_coins(&identity2.puzzle_hash).expect("got coin list");

    assert!(coins2_empty.is_empty());
    s.transfer_coin_amount(
        &mut allocator,
        &identity2,
        &identity1,
        &coins1[0],
        Amount::new(100)
    ).expect("should transfer");

    s.farm_block(&identity1.puzzle_hash);
    let coins2 = s.get_my_coins(&identity2.puzzle_hash).expect("got coins");
    assert_eq!(coins2.len(), 1);
}

#[test]
fn test_simulator_combine_coins() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::new();
    let private_key: PrivateKey = rng.gen();
    let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");

    s.farm_block(&identity.puzzle_hash);

    let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

    s.combine_coins(
        &mut allocator,
        &identity,
        &identity.puzzle_hash,
        &coins
    ).expect("should transfer");

    let pk2: PrivateKey = rng.gen();
    let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");
    s.farm_block(&identity2.puzzle_hash);
    let one_coin = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

    let (_, _, a1) = coins[0].to_parts().expect("should parse");
    let (_, _, a2) = coins[1].to_parts().expect("should parse");
    let (_, _, amt) = one_coin[0].to_parts().expect("should parse");

    assert_eq!(one_coin.len(), coins.len() - 1);
    assert_eq!(a1 + a2, amt);
}

#[test]
fn test_referee_can_slash_on_chain() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    // Generate keys and puzzle hashes.
    let my_private_key: PrivateKey = rng.gen();
    let my_identity = ChiaIdentity::new(&mut allocator, my_private_key).expect("should generate");

    let their_private_key: PrivateKey = rng.gen();
    let their_identity = ChiaIdentity::new(&mut allocator, their_private_key).expect("should generate");

    let amount = Amount::new(100);
    let timeout = Timeout::new(10);

    let debug_game = make_debug_game_handler(
        &mut allocator,
        &my_identity,
        &amount,
        &timeout
    );
    let init_state =
        assemble(
            allocator.allocator(),
            "(0 . 0)"
        ).expect("should assemble");
    let initial_validation_program = ValidationProgram::new(
        &mut allocator,
        debug_game.my_validation_program,
    );

    let amount = Amount::new(100);
    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: amount.clone(),
        game_handler: debug_game.my_turn_handler,
        timeout: timeout.clone(),
        my_contribution_this_game: Amount::new(50),
        their_contribution_this_game: Amount::new(50),
        initial_validation_program,
        initial_state: init_state,
        initial_move: vec![],
        initial_max_move_size: 100,
        initial_mover_share: Amount::default(),
    };

    let mut reftest = RefereeTest::new(
        &mut allocator,
        my_identity,
        their_identity,
        debug_game.their_turn_handler,
        &game_start_info,
    );

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(0));

    // Make simulator and create referee coin.
    let s = Simulator::new();
    s.farm_block(&reftest.my_identity.puzzle_hash);

    let coins = s.get_my_coins(
        &reftest.my_identity.puzzle_hash
    ).expect("got coins");
    assert!(coins.len() > 0);

    let readable_move = assemble(allocator.allocator(), "(100 . 0)").expect("should assemble");
    let _my_move_wire_data = reftest.my_referee
        .my_turn_make_move(
            &mut rng,
            &mut allocator,
            &ReadableMove::from_nodeptr(readable_move),
        )
        .expect("should move");

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(100));

    let (_, _, amt) = coins[0].to_parts().unwrap();
    let spend_to_referee = reftest.my_referee.curried_referee_puzzle_for_validator(
        &mut allocator,
    ).expect("should work");
    let referee_puzzle_hash = spend_to_referee.sha256tree(&mut allocator);

    let referee_coins = s.spend_coin_to_puzzle_hash(
        &mut allocator,
        &reftest.my_identity,
        &reftest.my_identity.puzzle,
        &coins[0],
        &[(referee_puzzle_hash.clone(), amt.clone())]
    ).expect("should create referee coin");

    // Farm 20 blocks to get past the time limit.
    for _ in 0..20 {
        s.farm_block(&reftest.my_identity.puzzle_hash);
    }

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(100));
    let timeout_transaction = reftest.my_referee.get_transaction_for_timeout(
        &mut allocator,
        &referee_coins[0],
    ).expect("should work").unwrap();

    let disassembled_puzzle_in_transaction = disassemble(
        allocator.allocator(),
        timeout_transaction.bundle.puzzle.to_nodeptr(),
        None
    );
    assert_eq!(
        disassemble(
            allocator.allocator(),
            spend_to_referee.to_nodeptr(),
            None
        ),
        disassembled_puzzle_in_transaction
    );

    eprintln!("timeout_transaction {timeout_transaction:?}");
    eprintln!("referee puzzle curried {}", disassemble(
        allocator.allocator(),
        timeout_transaction.bundle.puzzle.to_nodeptr(),
        None
    ));

    let specific = SpecificTransactionBundle {
        coin: referee_coins[0].clone(),
        bundle: timeout_transaction.bundle.clone()
    };

    let included = s.push_tx(&mut allocator, &[specific]).expect("should work");
    assert_eq!(included.code, 1);
}

#[test]
fn test_referee_can_move_on_chain() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    let agg_sig_me_additional_data = Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA);

    // Generate keys and puzzle hashes.
    let my_private_key: PrivateKey = rng.gen();
    let my_identity = ChiaIdentity::new(&mut allocator, my_private_key).expect("should generate");

    let their_private_key: PrivateKey = rng.gen();
    let their_identity = ChiaIdentity::new(&mut allocator, their_private_key).expect("should generate");

    let amount = Amount::new(100);
    let timeout = Timeout::new(10);
    let max_move_size = 100;

    let debug_game = make_debug_game_handler(
        &mut allocator,
        &my_identity,
        &amount,
        &timeout
    );
    let init_state =
        assemble(
            allocator.allocator(),
            "(0 . 0)"
        ).expect("should assemble");

    let my_validation_program = ValidationProgram::new(
        &mut allocator,
        debug_game.my_validation_program,
    );

    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: amount.clone(),
        game_handler: debug_game.my_turn_handler,
        timeout: timeout.clone(),
        my_contribution_this_game: Amount::new(50),
        their_contribution_this_game: Amount::new(50),
        initial_validation_program: my_validation_program,
        initial_state: init_state,
        initial_move: vec![],
        initial_max_move_size: max_move_size,
        initial_mover_share: Amount::default(),
    };

    let _their_validation_program_hash =
        Node(debug_game.their_validation_program).sha256tree(&mut allocator);

    let mut reftest = RefereeTest::new(
        &mut allocator,
        my_identity,
        their_identity,
        debug_game.their_turn_handler,
        &game_start_info,
    );

    let readable_move = assemble(allocator.allocator(), "(100 . 0)").expect("should assemble");
    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(0));

    // Make our first move.
    let _my_move_wire_data = reftest.my_referee
        .my_turn_make_move(
            &mut rng,
            &mut allocator,
            &ReadableMove::from_nodeptr(readable_move),
        )
        .expect("should move");

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(100));

    // Make simulator and create referee coin.
    let s = Simulator::new();
    s.farm_block(&reftest.my_identity.puzzle_hash);

    let coins = s.get_my_coins(
        &reftest.my_identity.puzzle_hash
    ).expect("got coins");
    assert!(coins.len() > 0);

    // Create the referee coin.
    let (_, _, amt) = coins[0].to_parts().unwrap();
    eprintln!("state at start of referee object");
    let spend_to_referee = reftest.my_referee.curried_referee_puzzle_for_validator(
        &mut allocator,
    ).expect("should work");
    let referee_puzzle_hash = spend_to_referee.sha256tree(&mut allocator);
    eprintln!(
        "referee start state {}",
        disassemble(allocator.allocator(), spend_to_referee.to_nodeptr(), None)
    );
    let referee_coins = s.spend_coin_to_puzzle_hash(
        &mut allocator,
        &reftest.my_identity,
        &reftest.my_identity.puzzle,
        &coins[0],
        &[(referee_puzzle_hash.clone(), amt.clone())]
    ).expect("should create referee coin");
    s.farm_block(&reftest.my_identity.puzzle_hash);

    // Make our move on chain.
    let move_transaction = reftest.my_referee.get_transaction_for_move(
        &mut allocator,
        &referee_coins[0],
        &agg_sig_me_additional_data
    ).expect("should work");

    eprintln!("move_transaction {move_transaction:?}");
    let specific = SpecificTransactionBundle {
        coin: referee_coins[0].clone(),
        bundle: move_transaction.bundle.clone()
    };

    let included = s.push_tx(&mut allocator, &[specific]).expect("should work");
    eprintln!("included {included:?}");
    assert_eq!(included.code, 1);
}
