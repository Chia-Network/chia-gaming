use std::rc::Rc;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::game_handler::{MyTurnInputs, TheirTurnInputs, TheirTurnResult};
use crate::channel_handler::types::ReadableMove;
use crate::common::types::{AllocEncoder, Amount, Hash, Node, Program};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo};
