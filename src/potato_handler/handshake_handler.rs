use rand::Rng;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{ChannelHandlerEnv, ReadableMove};
use crate::common::types::{
    Amount, CoinString, Error, GameID, Hash, Program, PuzzleHash, SpendBundle,
};
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

    pub fn get_reward_puzzle_hash<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<PuzzleHash, Error> {
        self.ph().get_reward_puzzle_hash(env)
    }

    pub fn my_move_in_game(&self, _game_id: &GameID) -> Option<bool> {
        None
    }

    pub fn get_game_coin(&self, _game_id: &GameID) -> Option<CoinString> {
        None
    }

    pub fn get_game_state_id<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Option<Hash>, Error> {
        Ok(None)
    }

    pub fn start<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        parent_coin: CoinString,
    ) -> Result<Option<Effect>, Error> {
        self.ph_mut().start(env, parent_coin)
    }

    pub fn channel_offer<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        let result = self.ph_mut().channel_offer(env, bundle)?;
        self.try_transition_safe();
        Ok(result)
    }

    pub fn channel_transaction_completion<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        let result = self.ph_mut().channel_transaction_completion(env, bundle)?;
        self.try_transition_safe();
        Ok(result)
    }

    pub fn received_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        let result = self.ph_mut().received_message(env, msg)?;
        self.try_transition_safe();
        Ok(result)
    }

    pub fn process_incoming_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Vec<Effect>, Error> {
        let result = self.ph_mut().process_incoming_message(env)?;
        self.try_transition_safe();
        Ok(result)
    }

    // --- Game action methods: not available during handshake ---

    pub fn make_move<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _id: &GameID,
        _readable: &ReadableMove,
        _new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "make_move not available during handshake".to_string(),
        ))
    }

    pub fn accept_timeout<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "accept_timeout not available during handshake".to_string(),
        ))
    }

    pub fn cheat_game<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _game_id: &GameID,
        _mover_share: Amount,
        _entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "cheat_game not available during handshake".to_string(),
        ))
    }

    pub fn go_on_chain<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "go_on_chain not available during handshake".to_string(),
        ))
    }
}

impl SpendWalletReceiver for HandshakeHandler {
    fn coin_created<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        let result = self.ph_mut().coin_created(env, coin)?;
        self.try_transition_safe();
        Ok(result)
    }

    fn coin_spent<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn coin_timeout_reached<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn coin_puzzle_and_solution<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        Ok((vec![], None))
    }
}
