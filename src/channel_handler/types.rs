use crate::common::types::{Amount, CoinString, PrivateKey, PublicKey, Aggsig, GameID};

struct ChannelHandlerPrivateKeys {
    my_channel_coin: PrivateKey,
    my_unroll_coin: PrivateKey,
    my_referee: PrivateKey,
}

struct ChannelHandlerPostInitialization {
    opponent_channel_coin_public_key: PublicKey,
    opponent_unroll_coin_public_key: PublicKey,
    opponent_referee_puzzle_hash: PuzzleHash,
    state_channel_coin_id: Option<CoinString>,
    my_out_of_game_balance: Amount,
    opponent_out_of_game_balance: Amount,
}

/// A channel handler runs the game by facilitating the phases of game startup
/// and passing on move information as well as termination to other layers.
pub enum ChannelHandler {
    BeforeHandshake {
        private_keys: ChannelHandlerPrivateKeys,
    },
    Initialized {
        private_keys: ChannelHandlerPrivateKeys,
        post_initialization: ChannelHandlerPostInitialization,
    },
    PostHandshake {
        private_keys: ChannelHandlerPrivateKeys,
        post_initialization: ChannelHandlerPostInitialization,

        opponent_referee_puzzle_hash: PuzzleHash,

        have_potato: bool,

        current_state_number: usize,

        last_channel_aggsig: Aggsig,
        last_unroll_aggsig: Aggsig,
        id_of_most_recent_created_game: Option<GameID>,
        id_of_most_recent_accepted_game: Option<GameID>,
        referee_of_most_recent_accepted_game: Option<RefereeID>,
    }
}
