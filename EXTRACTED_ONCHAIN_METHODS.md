# Extracted Methods from ChannelHandler for OnChainGameHandler

Complete implementation extraction from `src/channel_handler/mod.rs` with line numbers and dependencies.

---

## Part A: Methods to MOVE to OnChainGameHandler

### 1. save_game_state
**Lines:** 1817-1820

**Self fields accessed:** `live_games` (via `get_game_by_id`)

**Dependencies:** `get_game_by_id`

```rust
pub fn save_game_state(&self, game_id: &GameID) -> Result<(Rc<Referee>, PuzzleHash), Error> {
    let idx = self.get_game_by_id(game_id)?;
    Ok(self.live_games[idx].save_referee_state())
}
```

---

### 2. restore_game_state
**Lines:** 1822-1831

**Self fields accessed:** `live_games` (via `get_game_by_id`)

**Dependencies:** `get_game_by_id`

```rust
pub fn restore_game_state(
    &mut self,
    game_id: &GameID,
    referee: Rc<Referee>,
    last_ph: PuzzleHash,
) -> Result<(), Error> {
    let idx = self.get_game_by_id(game_id)?;
    self.live_games[idx].restore_referee_state(referee, last_ph);
    Ok(())
}
```

---

### 3. get_transaction_for_game_move
**Lines:** 1833-1841

**Self fields accessed:** `live_games` (via `get_game_by_id`)

**Dependencies:** `get_game_by_id`

```rust
pub fn get_transaction_for_game_move(
    &self,
    allocator: &mut AllocEncoder,
    game_id: &GameID,
    game_coin: &CoinString,
) -> Result<Spend, Error> {
    let idx = self.get_game_by_id(game_id)?;
    self.live_games[idx].get_transaction_for_move(allocator, game_coin)
}
```

---

### 4. get_game_outcome_puzzle_hash
**Lines:** 1843-1850

**Self fields accessed:** `live_games` (via `get_game_by_id`)

**Dependencies:** `get_game_by_id`

```rust
pub fn get_game_outcome_puzzle_hash<R: Rng>(
    &self,
    env: &mut ChannelHandlerEnv<R>,
    game_id: &GameID,
) -> Result<PuzzleHash, Error> {
    let idx = self.get_game_by_id(game_id)?;
    self.live_games[idx].outcome_puzzle_hash(env.allocator)
}
```

---

### 5. on_chain_our_move
**Lines:** 1871-1903

**Self fields accessed:** `live_games`, `state_number`

**Dependencies:** `get_game_by_id`

```rust
pub fn on_chain_our_move<R: Rng>(
    &mut self,
    env: &mut ChannelHandlerEnv<R>,
    game_id: &GameID,
    readable_move: &ReadableMove,
    entropy: Hash,
    existing_coin: &CoinString,
) -> Result<(PuzzleHash, PuzzleHash, usize, GameMoveDetails, Spend), Error> {
    let game_idx = self.get_game_by_id(game_id)?;

    let last_puzzle_hash = self.live_games[game_idx].last_puzzle_hash();
    let state_number = self.state_number;

    let move_result = self.live_games[game_idx].internal_make_move(
        env.allocator,
        readable_move,
        entropy,
        state_number,
    )?;

    let tx =
        self.live_games[game_idx].get_transaction_for_move(env.allocator, existing_coin)?;

    let post_outcome = self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?;

    Ok((
        last_puzzle_hash,
        post_outcome,
        self.state_number,
        move_result.details.clone(),
        tx,
    ))
}
```

---

### 6. game_coin_spent
**Lines:** 1905-1971

**Self fields accessed:** `live_games`, `state_number`

**Dependencies:** `get_reward_puzzle_hash`, `get_game_by_id`

```rust
pub fn game_coin_spent<R: Rng>(
    &mut self,
    env: &mut ChannelHandlerEnv<R>,
    game_id: &GameID,
    coin_string: &CoinString,
    conditions: &[CoinCondition],
) -> Result<CoinSpentInformation, Error> {
    let reward_puzzle_hash = self.get_reward_puzzle_hash(env)?;

    let (ph, amt) = if let Some((ph, amt)) = conditions
        .iter()
        .filter_map(|c| {
            if let CoinCondition::CreateCoin(ph, amt) = c {
                return Some((ph.clone(), amt.clone()));
            }

            None
        })
        .next()
    {
        (ph, amt)
    } else {
        return Err(Error::StrErr("bad coin".to_string()));
    };

    if reward_puzzle_hash == ph {
        return Ok(CoinSpentInformation::OurReward(ph.clone(), amt.clone()));
    }

    let live_game_idx = self.get_game_by_id(game_id)?;
    let state_number = self.state_number;

    // Forward-only alignment: if the new coin's PH matches our
    // referee's expected outcome, the opponent's move brought the
    // on-chain state to where our referee already is. Skip the
    // referee's coin-spend processing and return Expected directly.
    let our_on_chain_ph = self.live_games[live_game_idx].current_puzzle_hash(env.allocator)?;
    let our_outcome_ph = self.live_games[live_game_idx].outcome_puzzle_hash(env.allocator)?;
    if ph == our_on_chain_ph || ph == our_outcome_ph {
        let coin_being_spent_ph = coin_string.to_parts().map(|(_, p, _)| p);
        let matches_spent = coin_being_spent_ph.as_ref() == Some(&ph);
        if !matches_spent {
            self.live_games[live_game_idx].last_referee_puzzle_hash = ph.clone();
            return Ok(CoinSpentInformation::TheirSpend(
                TheirTurnCoinSpentResult::Expected(state_number, ph, amt, None),
            ));
        }
    }

    let spent_result = self.live_games[live_game_idx].their_turn_coin_spent(
        env.allocator,
        coin_string,
        conditions,
        state_number,
    )?;
    Ok(CoinSpentInformation::TheirSpend(spent_result))
}
```

---

### 7. accept_or_timeout_game_on_chain
**Lines:** 2034-2056

**Self fields accessed:** `live_games`, `pending_accept_timeouts`

**Dependencies:** `get_game_by_id`

```rust
pub fn accept_or_timeout_game_on_chain<R: Rng>(
    &mut self,
    env: &mut ChannelHandlerEnv<R>,
    game_id: &GameID,
    coin: &CoinString,
) -> Result<Option<Spend>, Error> {
    if let Ok(game_idx) = self.get_game_by_id(game_id) {
        let tx = self.live_games[game_idx].get_transaction_for_timeout(env.allocator, coin)?;
        self.live_games.remove(game_idx);
        Ok(tx)
    } else if let Some(idx) = self
        .pending_accept_timeouts
        .iter()
        .position(|g| g.game_id == *game_id)
    {
        let tx = self.pending_accept_timeouts[idx]
            .get_transaction_for_timeout(env.allocator, coin)?;
        self.pending_accept_timeouts.remove(idx);
        Ok(tx)
    } else {
        Ok(None)
    }
}
```

---

## Part B: Shared Methods (need DUPLICATING in both ChannelHandler and OnChainGameHandler)

### 8. game_is_my_turn
**Lines:** 1791-1805

**Self fields accessed:** `live_games`, `proposed_games`

```rust
pub fn game_is_my_turn(&self, game_id: &GameID) -> Option<bool> {
    for g in self.live_games.iter() {
        if g.game_id == *game_id {
            return Some(g.is_my_turn());
        }
    }

    for p in self.proposed_games.iter() {
        if p.game_id == *game_id {
            return Some(p.referee.is_my_turn());
        }
    }

    None
}
```

---

### 9. has_live_game
**Lines:** 1031-1033

**Self fields accessed:** `live_games`

```rust
pub fn has_live_game(&self, game_id: &GameID) -> bool {
    self.live_games.iter().any(|g| &g.game_id == game_id)
}
```

---

### 10. is_game_finished
**Lines:** 1035-1039

**Self fields accessed:** `live_games`

**Dependencies:** `get_game_by_id`

```rust
pub fn is_game_finished(&self, game_id: &GameID) -> bool {
    self.get_game_by_id(game_id)
        .map(|idx| self.live_games[idx].is_my_turn() && self.live_games[idx].is_game_over())
        .unwrap_or(false)
}
```

---

### 11. take_cached_move_for_game
**Lines:** 1854-1869

**Self fields accessed:** `cached_last_actions`

```rust
/// Extract cached move data (including saved S' referee) from
/// `cached_last_actions` for a specific game, removing that entry.
pub fn take_cached_move_for_game(
    &mut self,
    game_id: &GameID,
) -> Option<Rc<PotatoMoveCachedData>> {
    let pos = self.cached_last_actions.iter().position(|entry| {
        matches!(entry, CachedPotatoRegenerateLastHop::PotatoMoveHappening(d) if d.game_id == *game_id)
    });
    if let Some(idx) = pos {
        if let CachedPotatoRegenerateLastHop::PotatoMoveHappening(data) =
            self.cached_last_actions.remove(idx)
        {
            return Some(data);
        }
    }
    None
}
```

---

### 12. get_game_amount
**Lines:** 1086-1101

**Self fields accessed:** `live_games`, `pending_accept_timeouts`

```rust
pub fn get_game_amount(&self, game_id: &GameID) -> Result<Amount, Error> {
    if let Some(g) = self.live_games.iter().find(|g| g.game_id == *game_id) {
        return Ok(g.get_amount());
    }
    if let Some(g) = self
        .pending_accept_timeouts
        .iter()
        .find(|g| g.game_id == *game_id)
    {
        return Ok(g.get_amount());
    }
    Err(Error::StrErr(format!(
        "get_game_amount: game {:?} not found",
        game_id
    )))
}
```

---

### 13. get_game_our_current_share
**Lines:** 1041-1056

**Self fields accessed:** `live_games`, `pending_accept_timeouts`

```rust
pub fn get_game_our_current_share(&self, game_id: &GameID) -> Result<Amount, Error> {
    if let Some(g) = self.live_games.iter().find(|g| g.game_id == *game_id) {
        return g.get_our_current_share();
    }
    if let Some(g) = self
        .pending_accept_timeouts
        .iter()
        .find(|g| g.game_id == *game_id)
    {
        return g.get_our_current_share();
    }
    Err(Error::StrErr(format!(
        "get_game_our_current_share: game {:?} not found",
        game_id
    )))
}
```

---

### 14. enable_cheating_for_game
**Lines:** 1807-1815

**Self fields accessed:** `live_games`

**Dependencies:** `get_game_by_id`

```rust
pub fn enable_cheating_for_game(
    &mut self,
    game_id: &GameID,
    make_move: &[u8],
    mover_share: Amount,
) -> Result<bool, Error> {
    let game_idx = self.get_game_by_id(game_id)?;
    Ok(self.live_games[game_idx].enable_cheating(make_move, mover_share))
}
```

---

### 15. get_game_state_id
**Lines:** 2058-2065

**Self fields accessed:** `live_games`

```rust
pub fn get_game_state_id<R: Rng>(&self, env: &mut ChannelHandlerEnv<R>) -> Result<Hash, Error> {
    let mut bytes: Vec<u8> = Vec::with_capacity(self.live_games.len() * 32);
    for l in self.live_games.iter() {
        let ph = l.current_puzzle_hash(env.allocator)?;
        bytes.extend_from_slice(ph.bytes());
    }
    Ok(Sha256Input::Bytes(&bytes).hash())
}
```

---

### 16. amount (pub fn amount)
**Lines:** 235-241

**Self fields accessed:** `my_allocated_balance`, `their_allocated_balance`, `my_out_of_game_balance`, `their_out_of_game_balance`

```rust
pub fn amount(&self, on_chain: bool) -> Amount {
    let allocated = self.my_allocated_balance.clone() + self.their_allocated_balance.clone();

    if on_chain {
        return allocated;
    }

    allocated + self.my_out_of_game_balance.clone() + self.their_out_of_game_balance.clone()
}
```

---

### 17. get_reward_puzzle_hash
**Lines:** 267-271

**Self fields accessed:** `reward_puzzle_hash`

```rust
pub fn get_reward_puzzle_hash<R: Rng>(
    &self,
    _env: &mut ChannelHandlerEnv<R>,
) -> Result<PuzzleHash, Error> {
    Ok(self.reward_puzzle_hash.clone())
}
```

---

### 18. get_opponent_reward_puzzle_hash
**Lines:** 282-284

**Self fields accessed:** `their_reward_puzzle_hash`

```rust
pub fn get_opponent_reward_puzzle_hash(&self) -> PuzzleHash {
    self.their_reward_puzzle_hash.clone()
}
```

---

### 19. is_initial_potato
**Lines:** 147-149

**Self fields accessed:** `unroll.coin.started_with_potato`

```rust
pub fn is_initial_potato(&self) -> bool {
    self.unroll.coin.started_with_potato
}
```

---

### 20. get_game_by_id (helper used by on-chain methods)
**Lines:** 1103-1113

**Self fields accessed:** `live_games`

```rust
pub fn get_game_by_id(&self, game_id: &GameID) -> Result<usize, Error> {
    self.live_games
        .iter()
        .position(|g| &g.game_id == game_id)
        .map(Ok)
        .unwrap_or_else(|| {
            Err(Error::StrErr(
                "no live game with the given game id".to_string(),
            ))
        })
}
```

---

## Summary: Self Fields Used by Each Method

| Method | Self Fields |
|--------|-------------|
| save_game_state | live_games |
| restore_game_state | live_games |
| get_transaction_for_game_move | live_games |
| get_game_outcome_puzzle_hash | live_games |
| on_chain_our_move | live_games, state_number |
| game_coin_spent | live_games, state_number, reward_puzzle_hash (via get_reward_puzzle_hash) |
| accept_or_timeout_game_on_chain | live_games, pending_accept_timeouts |
| game_is_my_turn | live_games, proposed_games |
| has_live_game | live_games |
| is_game_finished | live_games |
| take_cached_move_for_game | cached_last_actions |
| get_game_amount | live_games, pending_accept_timeouts |
| get_game_our_current_share | live_games, pending_accept_timeouts |
| enable_cheating_for_game | live_games |
| get_game_state_id | live_games |
| amount | my_allocated_balance, their_allocated_balance, my_out_of_game_balance, their_out_of_game_balance |
| get_reward_puzzle_hash | reward_puzzle_hash |
| get_opponent_reward_puzzle_hash | their_reward_puzzle_hash |
| is_initial_potato | unroll.coin.started_with_potato |
| get_game_by_id | live_games |

---

## Required Imports for OnChainGameHandler

From the extracted code, these types/imports are needed:

```rust
use std::rc::Rc;
use rand::prelude::*;
use crate::channel_handler::types::{
    ChannelHandlerEnv, PotatoMoveCachedData, ReadableMove,
    CachedPotatoRegenerateLastHop, CoinSpentInformation,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinCondition, CoinString, Error, GameID, Hash,
    PuzzleHash, Sha256Input, Spend,
};
use crate::referee::types::{GameMoveDetails, TheirTurnCoinSpentResult};
use crate::referee::Referee;
```
