use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{ChannelHandlerEnv, ReadableMove};
use crate::channel_handler::ChannelHandler;
use crate::common::types::{
    Amount, CoinString, Error, GameID, Hash, Program, PuzzleHash, SpendBundle,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{Effect, ResyncInfo};
use crate::potato_handler::types::{BootstrapTowardGame, PotatoHandlerInit, SpendWalletReceiver};
use crate::potato_handler::PotatoHandler;

#[derive(Serialize, Deserialize)]
pub struct HandshakeHandler {
    inner: Option<PotatoHandler>,

    #[serde(skip)]
    debug_lines: Vec<String>,

    #[serde(skip)]
    replacement: Option<Box<PotatoHandler>>,
}

impl HandshakeHandler {
    pub fn new(phi: PotatoHandlerInit) -> Self {
        HandshakeHandler {
            inner: Some(PotatoHandler::new(phi)),
            debug_lines: Vec::new(),
            replacement: None,
        }
    }

    pub fn take_replacement(&mut self) -> Option<Box<PotatoHandler>> {
        self.replacement.take()
    }

    pub fn ph(&self) -> &PotatoHandler {
        self.inner.as_ref().expect("HandshakeHandler: inner consumed")
    }

    fn ph_mut(&mut self) -> &mut PotatoHandler {
        self.inner.as_mut().expect("HandshakeHandler: inner consumed")
    }

    fn try_transition_safe(&mut self) {
        if self.replacement.is_some() {
            return;
        }
        if let Some(ref inner) = self.inner {
            if inner.handshake_finished() && !inner.is_waiting_to_start() {
                let mut ph = self.inner.take().unwrap();
                self.debug_lines.extend(ph.take_debug_lines());
                self.replacement = Some(Box::new(ph));
            }
        }
    }

    // --- Delegated methods ---

    pub fn amount(&self) -> Amount {
        self.ph().amount()
    }

    pub fn has_potato(&self) -> bool {
        self.ph().has_potato()
    }

    pub fn has_pending_incoming(&self) -> bool {
        self.inner.as_ref().map_or(false, |ph| ph.has_pending_incoming())
    }

    pub fn handshake_done(&self) -> bool {
        false
    }

    pub fn handshake_finished(&self) -> bool {
        false
    }

    pub fn is_failed(&self) -> bool {
        self.ph().is_failed()
    }

    pub fn is_initiator(&self) -> bool {
        self.ph().is_initiator()
    }

    pub fn take_debug_lines(&mut self) -> Vec<String> {
        let mut lines = std::mem::take(&mut self.debug_lines);
        if let Some(ref mut inner) = self.inner {
            lines.extend(inner.take_debug_lines());
        }
        lines
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.ph().get_our_current_share()
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.ph().get_their_current_share()
    }

    pub fn get_reward_puzzle_hash(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<PuzzleHash, Error> {
        self.ph().get_reward_puzzle_hash(env)
    }

    pub fn my_move_in_game(&self, _game_id: &GameID) -> Option<bool> {
        None
    }

    pub fn get_game_coin(&self, _game_id: &GameID) -> Option<CoinString> {
        None
    }

    pub fn get_game_state_id(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Option<Hash>, Error> {
        Ok(None)
    }

    pub fn start(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        parent_coin: CoinString,
    ) -> Result<Option<Effect>, Error> {
        self.ph_mut().start(env, parent_coin)
    }

    pub fn channel_offer(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        let result = BootstrapTowardGame::channel_offer(self.ph_mut(), env, bundle)?;
        self.try_transition_safe();
        Ok(result)
    }

    pub fn channel_transaction_completion(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        let result = BootstrapTowardGame::channel_transaction_completion(self.ph_mut(), env, bundle)?;
        self.try_transition_safe();
        Ok(result)
    }

    pub fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        let result = self.ph_mut().received_message(env, msg)?;
        self.try_transition_safe();
        Ok(result)
    }

    pub fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        let result = self.ph_mut().process_incoming_message(env)?;
        self.try_transition_safe();
        Ok(result)
    }

    // --- Game action methods: not available during handshake ---

    pub fn make_move(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _id: &GameID,
        _readable: &ReadableMove,
        _new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "make_move not available during handshake".to_string(),
        ))
    }

    pub fn accept_timeout(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "accept_timeout not available during handshake".to_string(),
        ))
    }

    pub fn cheat_game(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _game_id: &GameID,
        _mover_share: Amount,
        _entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "cheat_game not available during handshake".to_string(),
        ))
    }

    pub fn go_on_chain(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "go_on_chain not available during handshake".to_string(),
        ))
    }
}

impl SpendWalletReceiver for HandshakeHandler {
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        let result = SpendWalletReceiver::coin_created(self.ph_mut(), env, coin)?;
        self.try_transition_safe();
        Ok(result)
    }

    fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn coin_timeout_reached(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn coin_puzzle_and_solution(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        Ok((vec![], None))
    }
}

#[typetag::serde]
impl PeerHandler for HandshakeHandler {
    fn amount(&self) -> Amount {
        HandshakeHandler::amount(self)
    }
    fn get_our_current_share(&self) -> Option<Amount> {
        HandshakeHandler::get_our_current_share(self)
    }
    fn get_their_current_share(&self) -> Option<Amount> {
        HandshakeHandler::get_their_current_share(self)
    }
    fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        HandshakeHandler::my_move_in_game(self, game_id)
    }
    fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        HandshakeHandler::get_game_coin(self, game_id)
    }
    fn get_reward_puzzle_hash(&self, env: &mut ChannelHandlerEnv<'_>) -> Result<PuzzleHash, Error> {
        HandshakeHandler::get_reward_puzzle_hash(self, env)
    }
    fn get_game_state_id(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Option<Hash>, Error> {
        HandshakeHandler::get_game_state_id(self, env)
    }
    fn is_failed(&self) -> bool {
        HandshakeHandler::is_failed(self)
    }
    fn has_potato(&self) -> bool {
        HandshakeHandler::has_potato(self)
    }
    fn has_pending_incoming(&self) -> bool {
        HandshakeHandler::has_pending_incoming(self)
    }
    fn take_debug_lines(&mut self) -> Vec<String> {
        HandshakeHandler::take_debug_lines(self)
    }
    fn process_incoming_message(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        HandshakeHandler::process_incoming_message(self, env)
    }
    fn received_message(&mut self, env: &mut ChannelHandlerEnv<'_>, msg: Vec<u8>) -> Result<Vec<Effect>, Error> {
        HandshakeHandler::received_message(self, env, msg)
    }
    fn coin_spent(&mut self, env: &mut ChannelHandlerEnv<'_>, coin_id: &CoinString) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(&mut self, env: &mut ChannelHandlerEnv<'_>, coin_id: &CoinString) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_created(&mut self, env: &mut ChannelHandlerEnv<'_>, coin_id: &CoinString) -> Result<Option<Vec<Effect>>, Error> {
        <Self as SpendWalletReceiver>::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        <Self as SpendWalletReceiver>::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
    fn make_move(&mut self, env: &mut ChannelHandlerEnv<'_>, id: &GameID, readable: &ReadableMove, new_entropy: Hash) -> Result<Vec<Effect>, Error> {
        HandshakeHandler::make_move(self, env, id, readable, new_entropy)
    }
    fn accept_timeout(&mut self, env: &mut ChannelHandlerEnv<'_>, id: &GameID) -> Result<Vec<Effect>, Error> {
        HandshakeHandler::accept_timeout(self, env, id)
    }
    fn cheat_game(&mut self, env: &mut ChannelHandlerEnv<'_>, game_id: &GameID, mover_share: Amount, entropy: Hash) -> Result<Vec<Effect>, Error> {
        HandshakeHandler::cheat_game(self, env, game_id, mover_share, entropy)
    }
    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>> {
        HandshakeHandler::take_replacement(self).map(|ph| ph as Box<dyn PeerHandler>)
    }
    fn handshake_done(&self) -> bool {
        HandshakeHandler::handshake_done(self)
    }
    fn handshake_finished(&self) -> bool {
        HandshakeHandler::handshake_finished(self)
    }
    fn channel_offer(&mut self, env: &mut ChannelHandlerEnv<'_>, bundle: SpendBundle) -> Result<Option<Effect>, Error> {
        HandshakeHandler::channel_offer(self, env, bundle)
    }
    fn channel_transaction_completion(&mut self, env: &mut ChannelHandlerEnv<'_>, bundle: &SpendBundle) -> Result<Option<Effect>, Error> {
        HandshakeHandler::channel_transaction_completion(self, env, bundle)
    }
    fn start(&mut self, env: &mut ChannelHandlerEnv<'_>, parent_coin: CoinString) -> Result<Option<Effect>, Error> {
        HandshakeHandler::start(self, env, parent_coin)
    }
    fn is_initiator(&self) -> bool {
        HandshakeHandler::is_initiator(self)
    }
    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        self.ph().channel_handler()
    }
}
