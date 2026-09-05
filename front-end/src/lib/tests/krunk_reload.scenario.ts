import { Program } from 'clvm-lib';
import {
  KrunkHandler,
  krunkStateCodec,
  type KrunkGameState,
  type KrunkHand,
  type KrunkHandState,
} from '@games/krunk/ui/serialize';
import type { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import type { HandProposal } from '../session/types';
import { createActivePair, exchangeUntilIdle, flushWrapperDrain } from './load_wasm.harness';
import {
  createReloadableSessionLane,
  injectSessionReload,
  type ReloadableSessionLane,
} from './reload_injection.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

const PENDING_CLUE = [-1n, -1n, -1n, -1n, -1n] as const;

function wordProgram(word: string): Program {
  return Program.fromBytes(new TextEncoder().encode(word));
}

function hand(lane: ReloadableSessionLane): KrunkHandState {
  const decoded = krunkStateCodec.decode(lane.runtime.getState().model.game.handState);
  assert.ok(decoded, 'Krunk reload checkpoint must have a complete hand payload');
  assert.equal(decoded.members.length, 2);
  return decoded;
}

function memberIndex(lane: ReloadableSessionLane, id: string): number {
  const index = lane.runtime.getState().model.game.currentHandIds.indexOf(id);
  assert.notEqual(index, -1, `Krunk reload checkpoint is missing member ${id}`);
  return index;
}

function game(lane: ReloadableSessionLane, id: string): KrunkGameState {
  return hand(lane).members[memberIndex(lane, id)]!;
}

function idForRole(lane: ReloadableSessionLane, role: KrunkGameState['role']): string {
  const state = lane.runtime.getState();
  const index = hand(lane).members.findIndex((member) => member.role === role);
  assert.notEqual(index, -1, `Krunk hand must contain a ${role} member`);
  return state.model.game.currentHandIds[index]!;
}

function makeMove(
  lane: ReloadableSessionLane,
  id: string,
  next: (current: KrunkGameState) => KrunkGameState,
  readable: Program | null,
): void {
  (lane.runtime.getGameHand() as KrunkHand).updateGame(memberIndex(lane, id), next);
  lane.runtime.commitLocalGameAction({
    gameType: 'krunk',
    id,
    command: { type: 'make-move', readable },
  });
}

function commitWord(lane: ReloadableSessionLane, id: string): void {
  makeMove(
    lane,
    id,
    (current) => ({
      ...current,
      handler: KrunkHandler.AliceWaiting,
      myTurn: false,
      secretWord: 'CRANE',
    }),
    wordProgram('CRANE'),
  );
}

function submitGuess(lane: ReloadableSessionLane, id: string, word: string): void {
  makeMove(
    lane,
    id,
    (current) => ({
      ...current,
      handler: KrunkHandler.BobWaiting,
      myTurn: false,
      guesses: [...current.guesses, { word, clue: [...PENDING_CLUE] }],
    }),
    wordProgram(word),
  );
}

function queueGuess(lane: ReloadableSessionLane, id: string, word: string): void {
  (lane.runtime.getGameHand() as KrunkHand).updateGame(memberIndex(lane, id), (current) => ({
    ...current,
    queuedGuesses: [...current.queuedGuesses, word],
  }));
  lane.runtime.commitHandStateChanged('krunk');
}

function submitNextQueuedGuess(lane: ReloadableSessionLane, id: string): void {
  const current = game(lane, id);
  const [word, ...queuedGuesses] = current.queuedGuesses;
  assert.ok(word, 'restored queue must contain a guess to submit');
  (lane.runtime.getGameHand() as KrunkHand).updateGame(memberIndex(lane, id), (state) => ({
    ...state,
    queuedGuesses,
  }));
  lane.runtime.commitHandStateChanged('krunk');
  submitGuess(lane, id, word);
}

function sendAutomaticClue(lane: ReloadableSessionLane, id: string): void {
  makeMove(
    lane,
    id,
    (current) => {
      const latest = current.guesses[current.guesses.length - 1];
      assert.ok(latest, 'automatic clue requires Alice to have received a guess');
      const terminal = latest.clue.every((value) => value === 2n) || current.guesses.length >= 5;
      return terminal
        ? {
            ...current,
            handler: KrunkHandler.Terminal,
            myTurn: false,
            revealedWord: current.secretWord,
            outcome: 'lose',
          }
        : { ...current, handler: KrunkHandler.AliceWaiting, myTurn: false };
    },
    null,
  );
}

export async function runKrunkReloadCoverage(poller: BlockchainPoller): Promise<void> {
  const adapters = await createActivePair(poller, 11);
  const proposal: HandProposal = {
    gameType: 'krunk',
    playerAContribution: 100n,
    playerBContribution: 100n,
    senderIsPlayerA: true,
    gameTimeout: 15n,
    parameters: null,
  };
  const lanes = adapters.map((adapter) => {
    const controller = adapter.blob!;
    const status = controller.lastChannelStatus;
    assert.ok(status, 'Krunk reload lane must begin with an active channel');
    return createReloadableSessionLane(
      adapter,
      controller,
      createSessionModel({
        channel: { status: channelStatusModelFromPayload(status) },
        game: { handKey: 1 },
        betweenHand: { mode: 'compose-proposal', lastHandProposal: proposal },
      }),
    );
  }) as [ReloadableSessionLane, ReloadableSessionLane];

  const reload = async (index: 0 | 1, label: string): Promise<Uint8Array> => {
    const beforeHand = structuredClone(lanes[index].runtime.getState().model.game.handState);
    const beforeIds = [...lanes[index].runtime.getState().model.game.currentHandIds];
    adapters[index].outbound_messages();
    lanes[index] = (await injectSessionReload(lanes[index], poller)).lane;
    assert.equal(
      lanes[index].controller.getRestoreStatus(),
      'restored',
      `${label}: restore status`,
    );
    assert.deepEqual(
      lanes[index].runtime.getState().model.game.handState,
      beforeHand,
      `${label}: hand payload`,
    );
    assert.deepEqual(
      lanes[index].runtime.getState().model.game.currentHandIds,
      beforeIds,
      `${label}: paired ids`,
    );
    const restoredHand = hand(lanes[index]);
    assert.equal(
      restoredHand.members.length,
      beforeIds.length,
      `${label}: restore must preserve the full-pair payload`,
    );
    return Uint8Array.from(lanes[index].controller.getWasmFields()!.serializedGameSession);
  };

  const assertAdvanced = (index: 0 | 1, before: Uint8Array, label: string): void => {
    assert.notDeepEqual(
      lanes[index].controller.getWasmFields()!.serializedGameSession,
      before,
      `${label}: restored live WASM state must advance`,
    );
  };

  const exchange = async (): Promise<void> => {
    await exchangeUntilIdle(adapters);
    await flushWrapperDrain(adapters);
  };

  lanes[0].runtime.dispatch({ type: 'submit-compose', handProposal: proposal });
  await exchange();
  const review = lanes[1].runtime
    .getState()
    .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-review');
  assert.ok(review);
  lanes[1].runtime.dispatch({ type: 'accept-review' });
  await exchange();

  const firstIds = [...lanes[0].runtime.getState().model.game.currentHandIds];
  assert.equal(firstIds.length, 2);
  assert.deepEqual(
    hand(lanes[0])
      .members.map((member) => member.role)
      .sort(),
    ['alice', 'bob'],
  );
  assert.deepEqual(
    hand(lanes[1])
      .members.map((member) => member.role)
      .sort(),
    ['alice', 'bob'],
  );

  const laneZeroAlice = idForRole(lanes[0], 'alice');
  const laneZeroBob = idForRole(lanes[0], 'bob');
  assert.notEqual(laneZeroAlice, laneZeroBob);
  assert.equal(idForRole(lanes[1], 'bob'), laneZeroAlice);
  assert.equal(idForRole(lanes[1], 'alice'), laneZeroBob);

  let checkpoint = await reload(0, 'WaitingCommit and initial BobWaiting');
  assert.equal(game(lanes[0], laneZeroAlice).handler, KrunkHandler.WaitingCommit);
  assert.equal(game(lanes[0], laneZeroBob).handler, KrunkHandler.BobWaiting);
  commitWord(lanes[0], laneZeroAlice);
  assertAdvanced(0, checkpoint, 'WaitingCommit');

  const aliceWaitingCheckpoint = await reload(0, 'AliceWaiting with queued commit');
  assert.equal(game(lanes[0], laneZeroAlice).handler, KrunkHandler.AliceWaiting);
  await exchange();
  assert.equal(game(lanes[1], laneZeroAlice).handler, KrunkHandler.BobGuess);

  submitGuess(lanes[1], laneZeroAlice, 'SLATE');
  queueGuess(lanes[1], laneZeroAlice, 'CRANE');
  const pendingClueCheckpoint = await reload(1, 'pending clue BobWaiting');
  const pending = game(lanes[1], laneZeroAlice);
  assert.equal(pending.handler, KrunkHandler.BobWaiting);
  assert.deepEqual(pending.guesses[0]?.clue, PENDING_CLUE);
  assert.deepEqual(pending.queuedGuesses, ['CRANE']);
  await exchange();
  assertAdvanced(0, aliceWaitingCheckpoint, 'AliceWaiting');
  assert.equal(game(lanes[0], laneZeroAlice).handler, KrunkHandler.AliceClue);

  checkpoint = await reload(0, 'AliceClue before automatic clue');
  const aliceGuessCount = game(lanes[0], laneZeroAlice).guesses.length;
  sendAutomaticClue(lanes[0], laneZeroAlice);
  assertAdvanced(0, checkpoint, 'AliceClue');
  await exchange();
  assertAdvanced(1, pendingClueCheckpoint, 'pending clue BobWaiting');
  const bobAfterClue = game(lanes[1], laneZeroAlice);
  assert.equal(bobAfterClue.handler, KrunkHandler.BobGuess);
  assert.equal(bobAfterClue.guesses.length, aliceGuessCount);
  assert.ok(bobAfterClue.guesses[0]?.clue.every((value) => value >= 0n));
  assert.deepEqual(bobAfterClue.queuedGuesses, ['CRANE']);

  submitNextQueuedGuess(lanes[1], laneZeroAlice);
  assert.deepEqual(game(lanes[1], laneZeroAlice).queuedGuesses, []);
  await exchange();
  assert.equal(game(lanes[0], laneZeroAlice).handler, KrunkHandler.AliceClue);
  const terminalClueGuessCount = game(lanes[0], laneZeroAlice).guesses.length;
  checkpoint = await reload(0, 'terminal AliceClue before automatic reveal');
  sendAutomaticClue(lanes[0], laneZeroAlice);
  assertAdvanced(0, checkpoint, 'terminal AliceClue');
  await exchange();
  assert.equal(game(lanes[0], laneZeroAlice).handler, KrunkHandler.Terminal);
  assert.equal(game(lanes[1], laneZeroAlice).handler, KrunkHandler.Terminal);
  assert.equal(
    game(lanes[1], laneZeroAlice).guesses.length,
    terminalClueGuessCount,
    'restored automatic reveal must not duplicate the triggering guess/clue',
  );
  assert.deepEqual(lanes[0].runtime.getState().model.game.activeIds, [laneZeroBob]);

  checkpoint = await reload(0, 'one terminal member with active sibling');
  assert.equal(game(lanes[0], laneZeroAlice).handler, KrunkHandler.Terminal);
  assert.equal(game(lanes[0], laneZeroBob).handler, KrunkHandler.BobWaiting);
  commitWord(lanes[1], laneZeroBob);
  await exchange();
  assertAdvanced(0, checkpoint, 'terminal member with active sibling');
  assert.equal(game(lanes[0], laneZeroBob).handler, KrunkHandler.BobGuess);

  checkpoint = await reload(0, 'BobGuess');
  submitGuess(lanes[0], laneZeroBob, 'CRANE');
  assertAdvanced(0, checkpoint, 'BobGuess');
  const secondPendingClueCheckpoint = await reload(0, 'second member pending clue');
  assert.deepEqual(game(lanes[0], laneZeroBob).guesses[0]?.clue, PENDING_CLUE);
  await exchange();
  assert.equal(game(lanes[1], laneZeroBob).handler, KrunkHandler.AliceClue);

  checkpoint = await reload(1, 'peer-role terminal AliceClue');
  sendAutomaticClue(lanes[1], laneZeroBob);
  assertAdvanced(1, checkpoint, 'peer-role terminal AliceClue');
  await exchange();
  assertAdvanced(0, secondPendingClueCheckpoint, 'second member pending clue');
  assert.deepEqual(lanes[0].runtime.getState().model.game.activeIds, []);
  assert.deepEqual(lanes[1].runtime.getState().model.game.activeIds, []);
  assert.ok(hand(lanes[0]).members.every((member) => member.handler === KrunkHandler.Terminal));

  checkpoint = await reload(0, 'terminal pair');
  lanes[0].runtime.dispatch({ type: 'choose-same-terms' });
  assertAdvanced(0, checkpoint, 'terminal pair');
  await exchange();
  const secondProposal = lanes[1].runtime
    .getState()
    .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-cached');
  assert.ok(secondProposal);
  const secondIds = secondProposal.memberIds;
  assert.equal(secondIds.length, 2);
  assert.notDeepEqual(secondIds, firstIds);
  lanes[1].runtime.dispatch({ type: 'choose-same-terms' });
  await exchange();

  assert.deepEqual(lanes[0].runtime.getState().model.game.currentHandIds, secondIds);
  assert.equal(hand(lanes[0]).members.length, 2);
  checkpoint = await reload(0, 'second paired hand');
  const secondAlice = idForRole(lanes[0], 'alice');
  commitWord(lanes[0], secondAlice);
  await exchange();
  assertAdvanced(0, checkpoint, 'second paired hand');
  assert.equal(game(lanes[1], secondAlice).handler, KrunkHandler.BobGuess);
}
