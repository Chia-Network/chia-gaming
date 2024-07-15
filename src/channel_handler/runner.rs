use rand::Rng;

use crate::channel_handler::{
    ChannelCoinSpendInfo, ChannelHandler, ChannelHandlerEnv, ChannelHandlerInitiationData,
    ChannelHandlerInitiationResult, ChannelHandlerPrivateKeys, HandshakeResult,
};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{
    get_standard_coin_puzzle, private_to_public_key, puzzle_for_pk, read_hex_puzzle,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinID, Error, GameID, Hash, Puzzle, PuzzleHash, Sha256tree,
};

pub struct ChannelHandlerParty {
    pub ch: ChannelHandler,
    pub init_data: ChannelHandlerInitiationResult,
    pub referee: Puzzle,
    pub ref_puzzle_hash: PuzzleHash,
    pub contribution: Amount,
}

impl ChannelHandlerParty {
    pub fn new<R: Rng>(
        env: &mut ChannelHandlerEnv<R>,
        private_keys: ChannelHandlerPrivateKeys,
        referee: Puzzle,
        ref_puzzle_hash: PuzzleHash,
        data: &ChannelHandlerInitiationData,
    ) -> Result<ChannelHandlerParty, Error> {
        let (ch, init_data) = ChannelHandler::new(env, private_keys, data)?;
        Ok(ChannelHandlerParty {
            ch,
            init_data,
            contribution: data.my_contribution.clone(),
            referee,
            ref_puzzle_hash,
        })
    }
}

pub struct ChannelHandlerGame {
    pub game_id: GameID,
    pub players: [ChannelHandlerParty; 2],
    pub handshake_result: [Option<HandshakeResult>; 2],
}

impl ChannelHandlerGame {
    pub fn new<R: Rng>(
        env: &mut ChannelHandlerEnv<R>,
        game_id: GameID,
        launcher_coin_id: &CoinID,
        contributions: &[Amount; 2],
    ) -> Result<ChannelHandlerGame, Error> {
        let private_keys: [ChannelHandlerPrivateKeys; 2] = env.rng.gen();

        let make_ref_info =
            |env: &mut ChannelHandlerEnv<R>, id: usize| -> Result<(Puzzle, PuzzleHash), Error> {
                let ref_key = private_to_public_key(&private_keys[id].my_referee_private_key);
                let referee = puzzle_for_pk(env.allocator, &ref_key)?;
                let ref_puzzle_hash = referee.sha256tree(env.allocator);
                Ok((referee, ref_puzzle_hash))
            };

        let ref1 = make_ref_info(env, 0)?;
        let ref2 = make_ref_info(env, 1)?;
        let referees = [ref1, ref2];

        let make_party =
            |env: &mut ChannelHandlerEnv<R>, id: usize| -> Result<ChannelHandlerParty, Error> {
                let data = ChannelHandlerInitiationData {
                    launcher_coin_id: launcher_coin_id.clone(),
                    we_start_with_potato: id == 1,
                    their_channel_pubkey: private_to_public_key(
                        &private_keys[id ^ 1].my_channel_coin_private_key,
                    ),
                    their_unroll_pubkey: private_to_public_key(
                        &private_keys[id ^ 1].my_unroll_coin_private_key,
                    ),
                    their_referee_puzzle_hash: referees[id ^ 1].1.clone(),
                    my_contribution: contributions[id].clone(),
                    their_contribution: contributions[id ^ 1].clone(),
                };

                ChannelHandlerParty::new(
                    env,
                    private_keys[id].clone(),
                    referees[id].0.clone(),
                    referees[id].1.clone(),
                    &data,
                )
            };

        let player1 = make_party(env, 0)?;
        let player2 = make_party(env, 1)?;

        Ok(ChannelHandlerGame {
            game_id,
            players: [player1, player2],
            handshake_result: [None, None],
        })
    }

    pub fn player(&mut self, who: usize) -> &mut ChannelHandlerParty {
        &mut self.players[who]
    }

    pub fn finish_handshake<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        who: usize,
    ) -> Result<(), Error> {
        let channel_coin_0_aggsig = self.players[who ^ 1]
            .init_data
            .my_initial_channel_half_signature_peer
            .clone();
        let handshake_result = self.players[who]
            .ch
            .finish_handshake(env, &channel_coin_0_aggsig)?;
        self.handshake_result[0] = Some(handshake_result.clone());
        self.handshake_result[1] = Some(handshake_result);
        Ok(())
    }

    pub fn update_channel_coin_after_receive(
        &mut self,
        player: usize,
        spend: &ChannelCoinSpendInfo,
    ) -> Result<(), Error> {
        if let Some(r) = &mut self.handshake_result[player] {
            eprintln!("UPDATE CHANNEL COIN AFTER RECEIVE");
            r.spend = spend.clone();
            return Ok(());
        }

        Err(Error::StrErr("not fully running".to_string()))
    }

    pub fn get_channel_coin_spend(&self, who: usize) -> Result<HandshakeResult, Error> {
        if let Some(r) = &self.handshake_result[who] {
            return Ok(r.clone());
        }

        Err(Error::StrErr(
            "get channel handler spend when not able to unroll".to_string(),
        ))
    }
}

pub fn channel_handler_env<'a, R: Rng>(
    allocator: &'a mut AllocEncoder,
    rng: &'a mut R,
) -> ChannelHandlerEnv<'a, R> {
    let referee_coin_puzzle =
        read_hex_puzzle(allocator, "onchain/referee.hex").expect("should be readable");
    let referee_coin_puzzle_hash: PuzzleHash = referee_coin_puzzle.sha256tree(allocator);
    let unroll_puzzle = read_hex_puzzle(
        allocator,
        "resources/unroll_puzzle_state_channel_unrolling.hex",
    )
    .expect("should read");
    let unroll_metapuzzle =
        read_hex_puzzle(allocator, "resources/unroll_meta_puzzle.hex").expect("should read");
    let standard_puzzle = get_standard_coin_puzzle(allocator).expect("should load");
    ChannelHandlerEnv {
        allocator,
        rng,
        referee_coin_puzzle,
        referee_coin_puzzle_hash,
        unroll_metapuzzle,
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
    }
}
