import { Program } from 'clvm-lib';
import { SessionController } from '../../hooks/SessionController';
import { flushSessionSave, peekSession, saveSession } from '../../hooks/save';
import type { ProposalAcceptedGroupPayload } from '../../types/ChiaGaming';
import { krunkBoardNotice } from '@games/krunk/ui/useKrunkHand';
import { krunkStateCodec, type KrunkGameState } from '@games/krunk/ui/serialize';
import { terminalInfoFromGameSettled } from '../session/gameSessionEvents';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { persistSessionSnapshot } from '../session/sessionMachinePersist';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import { validateSessionSaveEnvelope } from '../session/persistence';
import type { GameTerminalModel, HandProposal } from '../session/types';
import {
  addActiveSubscription,
  createActivePair,
  exchangeUntilIdle,
  flushWrapperDrain,
  startSimulator,
} from './load_wasm.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

interface KrunkSettlementTrace {
  phase: 'before-terminal' | 'after-terminal';
  gameId: string;
  state: KrunkGameState;
  terminal: GameTerminalModel;
  amount: string;
  perPlayerStake: bigint;
  myContribution: string;
  theirContribution: string;
}

async function runRealKrunkCompletionCase(poller: BlockchainPoller): Promise<void> {
  const cradles = await createActivePair(poller, 3);
  const controllers = cradles.map((cradle) => cradle.blob!) as [
    SessionController,
    SessionController,
  ];
  const handProposal: HandProposal = {
    gameType: 'krunk',
    playerAContribution: 100n,
    playerBContribution: 100n,
    senderIsPlayerA: true,
    gameTimeout: 15n,
    parameters: null,
  };
  const traces: Array<
    Array<{ currentHandIds: string[]; payloadMemberCount: number; activeIds: string[] }>
  > = [[], []];
  const errors: unknown[] = [];
  const runtimes: SessionMachineRuntime[] = [];
  const settlementTraces: KrunkSettlementTrace[][] = [[], []];
  const acceptedGroups: ProposalAcceptedGroupPayload[][] = [[], []];

  const settlementTrace = (
    index: number,
    gameId: string,
    phase: KrunkSettlementTrace['phase'],
    terminal: GameTerminalModel,
  ): KrunkSettlementTrace => {
    const machine = runtimes[index].getState();
    const hand = krunkStateCodec.decode(machine.model.game.handState);
    const memberIndex = machine.model.game.currentHandIds.indexOf(gameId);
    assert.notEqual(memberIndex, -1, `krunk completion player ${index}: unknown ${gameId}`);
    const state = hand?.members[memberIndex];
    const amount = machine.model.game.instances[gameId]?.amount;
    assert.ok(state, `krunk completion player ${index}: missing state for ${gameId}`);
    assert.ok(amount, `krunk completion player ${index}: missing amount for ${gameId}`);
    return {
      phase,
      gameId,
      state,
      terminal,
      amount,
      perPlayerStake: hand.perPlayerStake,
      myContribution: state.role === 'alice' ? amount : '0',
      theirContribution: state.role === 'alice' ? '0' : amount,
    };
  };

  for (const [index, controller] of controllers.entries()) {
    const status = controller.lastChannelStatus;
    assert.ok(status, `krunk completion player ${index}: missing active channel status`);
    const persist = async () => {
      const runtime = runtimes[index];
      assert.ok(
        runtime,
        `krunk completion player ${index}: persistence before runtime registration`,
      );
      const machine = runtime.getState();
      const currentHandIds = [...machine.model.game.currentHandIds];
      const hand = krunkStateCodec.decode(machine.model.game.handState);
      traces[index].push({
        currentHandIds,
        payloadMemberCount: hand?.members.length ?? 0,
        activeIds: [...machine.model.game.activeIds],
      });
      await persistSessionSnapshot({
        controller,
        getState: () => runtime.getState(),
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        save: async (save) => {
          await saveSession(save);
          validateSessionSaveEnvelope((await peekSession())!);
        },
      });
    };
    const runtime = new SessionMachineRuntime(
      createSessionMachineState(
        createSessionModel({
          channel: { status: channelStatusModelFromPayload(status) },
          game: { handKey: 1 },
          betweenHand: { mode: 'compose-proposal', lastHandProposal: handProposal },
        }),
        { firstGameAccepted: true },
      ),
      {
        controller,
        iStarted: index === 0,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: (error) => errors.push(error),
        persist,
      },
    );
    runtimes.push(runtime);
    controller.onSaveNeeded = persist;
    addActiveSubscription(
      controller.getObservable().subscribe((event) => {
        if (event.type === 'notification') {
          if ('ProposalAcceptedGroup' in event.data && event.data.ProposalAcceptedGroup) {
            acceptedGroups[index].push(event.data.ProposalAcceptedGroup);
          }
          if ('GameSettled' in event.data && event.data.GameSettled) {
            const id = String(event.data.GameSettled.id);
            const terminal = terminalInfoFromGameSettled(event.data.GameSettled, null);
            settlementTraces[index].push(settlementTrace(index, id, 'before-terminal', terminal));
            runtime.dispatch({
              type: 'wasm-notification',
              notification: event.data,
              iStarted: index === 0,
            });
            const instance = runtime.getState().model.game.instances[id];
            assert.ok(instance, `krunk completion player ${index}: missing settled instance`);
            settlementTraces[index].push(
              settlementTrace(index, id, 'after-terminal', instance.terminal),
            );
            return;
          }
          runtime.dispatch({
            type: 'wasm-notification',
            notification: event.data,
            iStarted: index === 0,
          });
        }
      }),
    );
  }

  const flushPersistence = async () => {
    await flushWrapperDrain(cradles);
    await Promise.all(controllers.map((controller) => controller.flushPendingSave()));
    await flushSessionSave();
    await Promise.resolve();
    assert.deepEqual(errors, []);
  };
  const exchangeAndPersist = async () => {
    await exchangeUntilIdle(cradles);
    await flushPersistence();
  };
  const word = Program.fromBytes(new TextEncoder().encode('CRANE'));

  try {
    runtimes[0].dispatch({ type: 'submit-compose', handProposal });
    await exchangeAndPersist();
    const review = runtimes[1]
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-review');
    assert.ok(review, 'krunk completion receiver must observe the real proposal');
    const ids = review.memberIds;
    assert.equal(ids.length, 2);

    runtimes[1].dispatch({ type: 'accept-review' });
    await exchangeAndPersist();

    for (const [index, groups] of acceptedGroups.entries()) {
      assert.equal(groups.length, 1, `krunk completion player ${index}: one real acceptance`);
      const acceptance = groups[0];
      assert.ok(acceptance);
      assert.deepEqual(
        acceptance.members.map((member) => [
          String(member.player_a_contribution),
          String(member.player_b_contribution),
        ]),
        [
          ['100', '0'],
          ['0', '100'],
        ],
      );
      const hand = krunkStateCodec.decode(runtimes[index].getState().model.game.handState);
      assert.ok(hand);
      assert.deepEqual(
        hand.members.map((member) => member.role),
        acceptance.members.map((member) => (member.our_turn ? 'alice' : 'bob')),
        `krunk completion player ${index}: roles must follow accepted turn authority`,
      );
      assert.deepEqual([...hand.members.map((member) => member.role)].sort(), ['alice', 'bob']);
    }
    const playerZeroAcceptance = acceptedGroups[0][0];
    const playerOneAcceptance = acceptedGroups[1][0];
    assert.ok(playerZeroAcceptance);
    assert.ok(playerOneAcceptance);
    for (let memberIndex = 0; memberIndex < 2; memberIndex += 1) {
      assert.notEqual(
        playerZeroAcceptance.members[memberIndex].our_turn,
        playerOneAcceptance.members[memberIndex].our_turn,
        `krunk completion member ${memberIndex}: peer turn authority must be complementary`,
      );
    }

    controllers[0].makeMove(ids[0], word);
    await exchangeAndPersist();
    controllers[1].makeMove(ids[0], word);
    await exchangeAndPersist();
    controllers[0].makeMove(ids[0], null);
    await exchangeAndPersist();

    controllers[1].makeMove(ids[1], word);
    await exchangeAndPersist();
    controllers[0].makeMove(ids[1], word);
    await exchangeAndPersist();
    controllers[1].makeMove(ids[1], null);
    await exchangeAndPersist();

    for (const [index, runtime] of runtimes.entries()) {
      assert.deepEqual(runtime.getState().model.game.activeIds, []);
      assert.deepEqual(runtime.getState().model.game.currentHandIds, ids);
      const hand = krunkStateCodec.decode(runtime.getState().model.game.handState);
      assert.ok(hand);
      assert.equal(hand.members.length, ids.length);
      assert.ok(
        traces[index].some(
          (trace) =>
            trace.activeIds.length === 1 &&
            trace.currentHandIds.join(',') === ids.join(',') &&
            trace.payloadMemberCount === ids.length,
        ),
        `krunk completion player ${index}: must persist the full pair after one member settles`,
      );
      for (const trace of traces[index]) {
        if (trace.currentHandIds.length === 0) continue;
        assert.equal(
          trace.payloadMemberCount,
          trace.currentHandIds.length,
          `krunk completion player ${index}: invalid persistence trace`,
        );
      }
    }

    for (const id of ids) {
      const byPlayer = settlementTraces.map((playerTraces, index) => {
        const before = playerTraces.filter(
          (trace) => trace.gameId === id && trace.phase === 'before-terminal',
        );
        const after = playerTraces.filter(
          (trace) => trace.gameId === id && trace.phase === 'after-terminal',
        );
        assert.equal(
          before.length,
          1,
          `krunk completion player ${index}: one terminal notification for ${id}`,
        );
        assert.equal(
          after.length,
          1,
          `krunk completion player ${index}: one durable terminal reduction for ${id}`,
        );
        assert.equal(
          after[0].state.moverShare,
          before[0].state.moverShare,
          `krunk completion player ${index}: terminal reduction must preserve moverShare for ${id}`,
        );
        if (before[0].state.outcome !== null) {
          assert.equal(
            after[0].state.outcome,
            before[0].state.outcome,
            `krunk completion player ${index}: terminal reduction must preserve outcome for ${id}`,
          );
        }
        assert.equal(after[0].terminal.outcome, 'accept_settlement');
        assert.equal(after[0].terminal.myReward, before[0].terminal.myReward);
        return after[0];
      });

      assert.notEqual(byPlayer[0].state.role, byPlayer[1].state.role);
      assert.deepEqual(
        [byPlayer[0].state.outcome, byPlayer[1].state.outcome].sort(),
        ['lose', 'win'],
        `krunk completion ${id}: outcomes must be complementary`,
      );
      assert.equal(byPlayer[0].amount, byPlayer[1].amount);
      assert.equal(byPlayer[0].myContribution, byPlayer[1].theirContribution);
      assert.equal(byPlayer[0].theirContribution, byPlayer[1].myContribution);
      assert.equal(
        BigInt(byPlayer[0].terminal.myReward!) + BigInt(byPlayer[1].terminal.myReward!),
        BigInt(byPlayer[0].amount),
        `krunk completion ${id}: local shares must partition the game amount`,
      );

      const notices = [
        krunkBoardNotice(byPlayer[0].state, 'Bob', byPlayer[0].perPlayerStake),
        krunkBoardNotice(byPlayer[1].state, 'Alice', byPlayer[1].perPlayerStake),
      ];
      const winner = byPlayer[0].state.outcome === 'win' ? 0 : 1;
      const loser = winner ^ 1;
      const won = byPlayer[winner].terminal.myReward;
      assert.ok(won);
      if (byPlayer[winner].state.role === 'alice') {
        assert.equal(
          notices[winner]?.text,
          `${winner === 0 ? 'Bob' : 'Alice'} didn't win anything.`,
        );
        assert.equal(notices[loser]?.text, "You didn't win anything.");
      } else {
        assert.equal(notices[winner]?.text, `You won ${won} mojo!`);
        assert.equal(
          notices[loser]?.text,
          `${winner === 0 ? 'Alice' : 'Bob'} won ${byPlayer[loser].perPlayerStake} mojo!`,
        );
      }
    }

    const traceCountsBeforeSecondHand = traces.map((playerTraces) => playerTraces.length);
    runtimes[1].dispatch({ type: 'choose-same-terms' });
    assert.equal(
      runtimes[1].getState().model.betweenHand.mode,
      'decision',
      'Krunk repeat proposer must bypass the compose form',
    );
    await exchangeAndPersist();
    assert.equal(
      runtimes[0].getState().model.betweenHand.mode,
      'decision',
      'Krunk repeat receiver must cache exact terms without opening the form',
    );
    const cachedSecondProposal = runtimes[0]
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-cached');
    assert.ok(cachedSecondProposal, 'krunk completion receiver must cache the same-terms proposal');
    const secondIds = cachedSecondProposal.memberIds;
    assert.equal(secondIds.length, 2);
    assert.notDeepEqual(secondIds, ids);

    runtimes[0].dispatch({ type: 'choose-same-terms' });
    assert.equal(
      runtimes[0].getState().model.betweenHand.mode,
      'decision',
      'Krunk repeat acceptance must bypass the compose form',
    );
    await exchangeAndPersist();

    for (const [index, runtime] of runtimes.entries()) {
      assert.deepEqual(runtime.getState().model.game.currentHandIds, secondIds);
      const hand = krunkStateCodec.decode(runtime.getState().model.game.handState);
      assert.ok(hand);
      assert.equal(hand.members.length, secondIds.length);
      const secondHandTraces = traces[index]
        .slice(traceCountsBeforeSecondHand[index])
        .filter(
          (trace) =>
            trace.currentHandIds.length === secondIds.length &&
            trace.currentHandIds.every((id, idIndex) => id === secondIds[idIndex]),
        );
      assert.ok(
        secondHandTraces.length >= 2,
        `krunk completion player ${index}: each second-hand member acceptance must persist`,
      );
      for (const trace of secondHandTraces) {
        assert.deepEqual(trace.currentHandIds, secondIds);
        assert.equal(trace.payloadMemberCount, secondIds.length);
      }
    }
  } finally {
    controllers.forEach((controller) => {
      controller.onSaveNeeded = null;
    });
  }
}

it(
  'completes and persists paired real Krunk games',
  async () => {
    try {
      const poller = await startSimulator(['cafe0003', 'dead0003']);
      if (!poller) return;
      await runRealKrunkCompletionCase(poller);
    } catch (e) {
      throw new Error(`[load_wasm Krunk completion failed]\n${String(e)}`, { cause: e });
    }
  },
  300 * 1000,
);
