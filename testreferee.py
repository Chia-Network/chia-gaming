import pytest
import json
from hashlib import sha256
from contextlib import asynccontextmanager
from chia.clvm.spend_sim import SimClient, SpendSim
from pathlib import Path
from clvm.casts import int_to_bytes, int_from_bytes

from hsms.streamables.program import Program
from clvm_tools_rs import compile_clvm
from clvm_tools.binutils import disassemble

from clvm.EvalError import EvalError
from chia.types.mempool_inclusion_status import MempoolInclusionStatus
from chia.util.errors import Err
from dataclasses import dataclass
from typing import Any
from chia_rs import Coin
from chia.types.spend_bundle import SpendBundle
from chia.types.coin_spend import CoinSpend
from blspy import G2Element

from steprun import diag_run_clvm, compile_module_with_symbols

compile_module_with_symbols(['.'],'referee.clsp')
referee = Program.from_bytes(bytes.fromhex(open("referee.clvm.hex").read()))
refhash = referee.tree_hash()
compile_module_with_symbols(['.'],'referee_accuse.clsp')
referee_accuse = Program.from_bytes(bytes.fromhex(open("referee_accuse.clvm.hex").read()))
refaccusehash = referee.tree_hash()
compile_clvm('rockpaperscissorsa.clsp', 'rockpaperscissorsa.clvm.hex', ['.'])
MOD_A = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsa.clvm.hex").read()))
compile_clvm('rockpaperscissorsb.clsp', 'rockpaperscissorsb.clvm.hex', ['.'])
MOD_B = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsb.clvm.hex").read()))
compile_clvm('rockpaperscissorsc.clsp', 'rockpaperscissorsc.clvm.hex', ['.'])
MOD_C = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsc.clvm.hex").read()))
compile_clvm('rockpaperscissorsd.clsp', 'rockpaperscissorsd.clvm.hex', ['.'])
MOD_D = Program.from_bytes(bytes.fromhex(open("rockpaperscissorsd.clvm.hex").read()))

move = 0
accuse = 1
timeout = 2

def drun(prog: Program, *args: Program):
    try:
        return prog.run(*args)
    except EvalError as ee:
        print(f"brun -x -y main.sym {prog} {Program.to(list(args))}")
        raise

def sha(blob:bytes) -> bytes:
    return sha256(blob).digest()

@pytest.fixture(scope="function")
@asynccontextmanager
async def setup_sim() :
    sim = await SpendSim.create(db_path=Path("file:db_test?mode=memory&cache=shared"))
    sim_client = SimClient(sim)
    await sim.farm_block()

    try:
        yield sim, sim_client
    finally:
        await sim.close()

def bootstrap_referee(parent_coin_id, initial_validation_program_hash, initial_split, 
        amount, timeout, max_move_size, mover_puzzle, waiter_puzzle):
    """
    returns referee_wrap
    """
    puzzle_hash = referee.curry(
        [initial_validation_program_hash, 0, initial_split, amount, timeout, max_move_size, mover_puzzle.tree_hash(), 
        waiter_puzzle.tree_hash(), referee.tree_hash()]).tree_hash()
    coin = Coin(parent_coin_id, puzzle_hash, amount)
    return RefereeWrap(coin, bytes(32), bytes(32), bytes(32),
            initial_validation_program_hash, 0, initial_split, timeout, max_move_size, 
            mover_puzzle, waiter_puzzle)

@dataclass
class RefereeWrap:
    coin: Any
    grandparent_id: Any
    parent_validation_program_hash: Any
    parent_everything_else_hash: Any
    validation_program_hash: Any
    move: Any
    split: Any
    timeout: Any
    max_move_size: Any
    mover_puzzle: Any
    waiter_puzzle: Any

    def curried_parameters_for_our_puzzle(self, purpose, for_self, move_to_make, split, validation_program_hash):
        result = Program.to([
            validation_program_hash,
            move_to_make,
            split,
            self.coin.amount,
            self.timeout,
            self.max_move_size,
            self.mover_puzzle.tree_hash() if for_self else self.waiter_puzzle.tree_hash(),
            self.waiter_puzzle.tree_hash() if for_self else self.mover_puzzle.tree_hash(),
            refhash
        ])
        print(f'for {purpose} curried_parameters_for_our_puzzle is {result}')
        return result

    def get_puzzle(self):
        return referee.curry(self.curried_parameters_for_our_puzzle(
            "GET_PUZZLE",
            True,
            self.move,
            self.split,
            self.validation_program_hash
        ))

    def SpendMove(self, password, move_to_make, split, validation_program_hash):
        """
        returns (solution, new RefereeWrap)
        """
        print(f"MOVE referee mover_puzzle {self.mover_puzzle.tree_hash()}")
        print(f"MOVE referee waiter_puzzle {self.waiter_puzzle.tree_hash()}")
        curried_parameters = self.curried_parameters_for_our_puzzle(
            "SPEND_MOVE",
            False,
            move_to_make,
            split,
            validation_program_hash
        )
        print(f"MOVE referee curried parameters {curried_parameters}")
        new_puzzle_hash = referee.curry(curried_parameters).tree_hash()
        print(f"MOVE new puzzle hash {Program.to(new_puzzle_hash)}")
        solution = Program.to([move, move_to_make, split, validation_program_hash, self.mover_puzzle, 
                               [password, [51, new_puzzle_hash, self.coin.amount]]])
        coin = Coin(self.coin.name(), new_puzzle_hash, self.coin.amount)
        everything_else_hash = Program.to([self.move, self.split, self.coin.amount, self.timeout, 
                self.max_move_size, self.mover_puzzle.tree_hash(), self.waiter_puzzle.tree_hash(), 
                referee.tree_hash()]).tree_hash()
        return (solution, RefereeWrap(coin, self.coin.parent_coin_info, self.validation_program_hash, everything_else_hash,
            validation_program_hash, move_to_make, split, self.timeout, self.max_move_size,
            self.waiter_puzzle, self.mover_puzzle))

    def SpendAccuse(self, password):
        """
        returns (solution, RefereeAccuse)
        """
        print(f"ACCUSE starting with puzzle hash {Program.to(self.get_puzzle().tree_hash())}")
        print(f"ACCUSE parent_id {Program.to(self.coin.parent_coin_info)}")
        print(f"ACCUSE referee mover_puzzle {self.mover_puzzle.tree_hash()}")
        print(f"ACCUSE referee waiter_puzzle {self.waiter_puzzle.tree_hash()}")
        new_puzzle_hash = referee_accuse.curry([
            self.parent_validation_program_hash,
            self.validation_program_hash,
            self.move,
            self.split,
            self.coin.amount,
            self.timeout,
            self.waiter_puzzle.tree_hash(),
            self.mover_puzzle.tree_hash()
        ]).tree_hash()
        solution = Program.to([accuse, self.grandparent_id, self.parent_validation_program_hash,
                self.parent_everything_else_hash, self.mover_puzzle, [password, [51, new_puzzle_hash, self.coin.amount]]])
        coin = Coin(self.coin.name(), new_puzzle_hash, self.coin.amount)
        return (solution, RefereeAccuseWrap(coin, self.parent_validation_program_hash, self.validation_program_hash,
                self.move, self.split, self.timeout, self.waiter_puzzle.tree_hash(),
                self.mover_puzzle.tree_hash()))

    def SpendTimeout(self):
        """
        returns (solution, movercoinid, waitercoinid)
        """
        movercoinid = Coin(self.coin.name(), self.mover_puzzle.tree_hash(), self.split).name()
        waitercoinid = Coin(self.coin.name(), self.waiter_puzzle.tree_hash(), 
                self.coin.amount - self.split).name()
        return (Program.to((timeout, 0)), movercoinid, waitercoinid)

@dataclass
class RefereeAccuseWrap:
    coin: Any
    old_validation_puzzle_hash: Any
    new_validation_puzzle_hash: Any
    move: Any
    split: Any
    timeout: Any
    accused_puzzle_hash: Any
    accuser_puzzle_hash: Any

    def get_puzzle(self):
        return referee_accuse.curry([self.old_validation_puzzle_hash, self.new_validation_puzzle_hash,
                self.move, self.split, self.coin.amount, self.timeout, self.accused_puzzle_hash,
                self.accuser_puzzle_hash])

    def SpendTimeout(self):
        """
        returns (solution, coinid)
        """
        coin = Coin(self.coin.name(), self.accuser_puzzle_hash, self.coin.amount)
        return (Program.to(0), coin.name())

    def SpendDefend(self, validation_program_reveal, validation_program_solution):
        """
        returns (solution, coinid)
        """
        solution = Program.to([validation_program_reveal, validation_program_solution])
        coin = Coin(self.coin.name(), self.accused_puzzle_hash, self.coin.amount)
        return (solution, coin.name())

@pytest.mark.asyncio
@pytest.mark.parametrize('amove', [0, 1, 2])
@pytest.mark.parametrize('bmove', [0, 1, 2])
async def test_rps(amove, bmove, setup_sim):
    total = 100
    alice_final = (total//2 if amove == bmove else (0 if bmove == (amove + 1) % 3 else total))
    alice_preimage = int_to_bytes(60 + amove)
    alice_image = sha(alice_preimage)
    bob_preimage = int_to_bytes(60 + bmove)
    bob_image = sha(bob_preimage)
    alice_move = int_to_bytes(amove)
    nil = Program.to(0)

    # (mod (password . conditions) (if (= password 'alice') conditions (x)))
    alice_puzzle = Program.from_bytes(bytes.fromhex('ff02ffff03ffff09ff02ffff0185616c69636580ffff0103ffff01ff088080ff0180'))
    alice_puzzle_hash = alice_puzzle.tree_hash()
    # (mod (password . conditions) (if (= password 'bob') conditions (x)))
    bob_puzzle = Program.from_bytes(bytes.fromhex('ff02ffff03ffff09ff02ffff0183626f6280ffff0103ffff01ff088080ff0180'))
    bob_puzzle_hash = bob_puzzle.tree_hash()

    async with setup_sim as (sym, client):
        acs = Program.to(1)
        acs_hash = acs.tree_hash()
        await sym.farm_block(acs_hash)
        mycoin = (await client.get_coin_records_by_puzzle_hashes([acs_hash], include_spent_coins = False))[0].coin
        # make a coin for a game
        referee = bootstrap_referee(mycoin.name(), MOD_A.tree_hash(), 2, total, 1000, 50, alice_puzzle, bob_puzzle)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(mycoin, acs, Program.to([[51, referee.coin.puzzle_hash, 
                referee.coin.amount]]))], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        savepoint = sym.block_height
        # Alice accuse Bob of cheating (negative test, should fail)
        solution, accuse = referee.SpendAccuse('alice')
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(referee.coin, referee.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.ASSERT_MY_PARENT_ID_FAILED
        # timeout too early fail
        solution, alice_reward_id, bob_reward_id = referee.SpendTimeout()
        spend = SpendBundle([CoinSpend(referee.coin, referee.get_puzzle(), solution)], G2Element())
        (status, err) = await client.push_tx(spend)
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.ASSERT_SECONDS_RELATIVE_FAILED
        # timeout succeeds
        sym.pass_time(2000)
        await sym.farm_block()
        (status, err) = await client.push_tx(spend)
        assert status == MempoolInclusionStatus.SUCCESS
        assert err is None
        await sym.farm_block()
        assert (await client.get_coin_records_by_names([alice_reward_id], include_spent_coins = False))[0].coin.amount == 2
        assert (await client.get_coin_records_by_names([bob_reward_id], include_spent_coins = False))[0].coin.amount == total - 2
        await sym.rewind(savepoint)
        # Alice makes an illegally large move, fails
        solution, ref2 = referee.SpendMove('alice', bytes(100), 0, bytes(32))
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(referee.coin, referee.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.GENERATOR_RUNTIME_ERROR
        # Alice makes move with negative split, fails
        solution, ref2 = referee.SpendMove('alice', 'abc', -1, bytes(32))
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(referee.coin, referee.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.GENERATOR_RUNTIME_ERROR
        # Alice makes move with split greater than amount, fails
        solution, ref2 = referee.SpendMove('alice', 'abc', referee.coin.amount + 1, bytes(32))
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(referee.coin, referee.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.GENERATOR_RUNTIME_ERROR
        # Alice move 1 commit to image
        bpuz = MOD_B.curry(alice_image)
        solution, ref2 = referee.SpendMove('alice', alice_image, 0, bpuz.tree_hash())
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(referee.coin, referee.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        savepoint = sym.block_height
        # Bob accuse Alice of cheating
        solution, accuse = ref2.SpendAccuse('bob')
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref2.coin, ref2.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        savepoint2 = sym.block_height
        # Alice accusation defend, gets everything
        solution, reward_id = accuse.SpendDefend(MOD_A, nil)
        print(solution)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        reward_coin_wrapper = await client.get_coin_records_by_names([reward_id], include_spent_coins = 
                False)
        reward_coin = reward_coin_wrapper[0].coin
        assert reward_coin.amount == referee.coin.amount
        assert reward_coin.puzzle_hash == alice_puzzle_hash
        await sym.rewind(savepoint2)
        # accusation timeout too early fail
        solution, reward_id = accuse.SpendTimeout()
        spend = SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), solution)], G2Element())
        (status, err) = await client.push_tx(spend)
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.ASSERT_SECONDS_RELATIVE_FAILED
        # accusation timeout succeed, Bob gets everything
        sym.pass_time(2000)
        await sym.farm_block()
        (status, err) = await client.push_tx(spend)
        assert status == MempoolInclusionStatus.SUCCESS
        assert err is None
        await sym.farm_block()
        reward_coin_wrapper = await client.get_coin_records_by_names([reward_id], include_spent_coins = 
                False)
        reward_coin = reward_coin_wrapper[0].coin
        assert reward_coin.amount == referee.coin.amount
        assert reward_coin.puzzle_hash == bob_puzzle_hash
        await sym.rewind(savepoint)
        # Bob move 2 commit to image
        cpuz = MOD_C.curry([alice_image, bob_image])
        solution, ref3 = ref2.SpendMove('bob', bob_image, 0, cpuz.tree_hash())
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref2.coin, ref2.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        savepoint = sym.block_height
        # Alice accuse
        solution, accuse = ref3.SpendAccuse('alice')
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref3.coin, ref3.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        # Bob defends
        solution, reward_id = accuse.SpendDefend(bpuz, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        reward_coin = (await client.get_coin_records_by_names([reward_id], include_spent_coins = 
                False))[0].coin
        assert reward_coin.amount == referee.coin.amount
        assert reward_coin.puzzle_hash == bob_puzzle_hash
        await sym.rewind(savepoint)
        # Alice reveals wrong preimage
        alice_bad_preimage = int_to_bytes(61 + amove)
        dpuz = MOD_D.curry([(amove + 1) % 3, bob_image])
        solution, ref4 = ref3.SpendMove('alice', alice_bad_preimage, 0, dpuz.tree_hash())
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref3.coin, ref3.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        # Bob accuses
        solution, accuse = ref4.SpendAccuse('bob')
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref4.coin, ref4.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        # Alice defends, fails
        solution, reward_id = accuse.SpendDefend(cpuz, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.GENERATOR_RUNTIME_ERROR
        await sym.rewind(savepoint)
        # Alice move 3 reveal preimage
        dpuz = MOD_D.curry([alice_move, bob_image])
        solution, ref4 = ref3.SpendMove('alice', alice_preimage, 0, dpuz.tree_hash())
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref3.coin, ref3.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        savepoint = sym.block_height
        # Bob accuses
        solution, accuse = ref4.SpendAccuse('bob')
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref4.coin, ref4.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        # Alice defends
        solution, reward_id = accuse.SpendDefend(cpuz, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.rewind(savepoint)
        # Bob move 4 reveal wrong preimage
        bob_bad_preimage = int_to_bytes(121 + amove)
        solution, ref5 = ref4.SpendMove('bob', bob_bad_preimage, 0, dpuz.tree_hash())
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref4.coin, ref4.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        # Alice accuses
        solution, accuse = ref5.SpendAccuse('alice')
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref5.coin, ref5.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        # Bob attempts defense, fails
        solution, reward_id = accuse.SpendDefend(dpuz, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.GENERATOR_RUNTIME_ERROR
        # Bob attempts defense with wrong validation program, fails
        solution, reward_id = accuse.SpendDefend(acs, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.GENERATOR_RUNTIME_ERROR
        await sym.rewind(savepoint)
        if amove == bmove:
            # Bob move 4 gives wrong split
            solution, ref5 = ref4.SpendMove('bob', bob_preimage, 0, dpuz.tree_hash())
            (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref4.coin, ref4.get_puzzle(), 
                    solution)], G2Element()))
            assert status == MempoolInclusionStatus.SUCCESS
            await sym.farm_block()
            # Alice accuses
            solution, accuse = ref5.SpendAccuse('alice')
            (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref5.coin, ref5.get_puzzle(), 
                    solution)], G2Element()))
            assert status == MempoolInclusionStatus.SUCCESS
            await sym.farm_block()
            # Bob attempts defense, fails
            solution, reward_id = accuse.SpendDefend(dpuz, nil)
            (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                    solution)], G2Element()))
            assert status == MempoolInclusionStatus.FAILED
            assert err == Err.GENERATOR_RUNTIME_ERROR
            await sym.rewind(savepoint)
        # Bob move 4 reveal preimage
        solution, ref5 = ref4.SpendMove('bob', bob_preimage, alice_final, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref4.coin, ref4.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        savepoint = sym.block_height
        # Alice attempts move, fails
        solution, ref6 = ref5.SpendMove('alice', nil, 0, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref5.coin, ref5.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.FAILED
        assert err == Err.GENERATOR_RUNTIME_ERROR
        # timeout, split correct
        sym.pass_time(2000)
        await sym.farm_block()
        solution, alice_reward_id, bob_reward_id = ref5.SpendTimeout()
        spend = SpendBundle([CoinSpend(ref5.coin, ref5.get_puzzle(), solution)], G2Element())
        (status, err) = await client.push_tx(spend)
        assert status == MempoolInclusionStatus.SUCCESS
        assert err is None
        await sym.farm_block()
        if alice_final != 0:
            assert (await client.get_coin_records_by_names([alice_reward_id], include_spent_coins = False))[0].coin.amount == alice_final
        else:
            assert len(await client.get_coin_records_by_names([alice_reward_id], include_spent_coins = False)) == 0
        if alice_final != ref5.coin.amount:
            assert (await client.get_coin_records_by_names([bob_reward_id], include_spent_coins = False))[0].coin.amount == ref5.coin.amount - alice_final
        else:
            assert len(await client.get_coin_records_by_names([bob_reward_id], include_spent_coins = False)) == 0
        await sym.rewind(savepoint)
        # Alice accuses
        solution, accuse = ref5.SpendAccuse('alice')
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(ref5.coin, ref5.get_puzzle(), 
                solution)], G2Element()))
        assert status == MempoolInclusionStatus.SUCCESS
        await sym.farm_block()
        # Bob defends
        solution, reward_id = accuse.SpendDefend(dpuz, nil)
        (status, err) = await client.push_tx(SpendBundle([CoinSpend(accuse.coin, accuse.get_puzzle(), 
                solution)], G2Element()))
        assert (status, err) == (MempoolInclusionStatus.SUCCESS, None)
