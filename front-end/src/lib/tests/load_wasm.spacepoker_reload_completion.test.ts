import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { GameIntent, LiveGamePort } from '@games/host';
import {
  spacepokerStateCodec,
  type SpacepokerHand,
  type SpacepokerHandState,
} from '@games/spacepoker/ui/serialize';
import {
  SpHandler,
  useSpacepokerHand,
  type UseSpacepokerHandResult,
} from '@games/spacepoker/ui/useSpacepokerHand';
import type { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import type { HandProposal } from '../session/types';
import {
  createActivePair,
  exchangeUntilIdle,
  flushWrapperDrain,
  startSimulator,
  type SessionControllerAdapter,
} from './load_wasm.harness';
import {
  createReloadableSessionLane,
  injectSessionReload,
  type ReloadableSessionLane,
} from './reload_injection.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

type TerminalMode = 'reveal' | 'concede';

class SpacepokerReloadDriver {
  readonly reachedHandlers = new Set<bigint>();
  readonly submittedMoves = [0, 0];
  readonly submittedSettlements = [0, 0];
  private readonly hookResults: Array<UseSpacepokerHandResult | null> = [null, null];
  private readonly renderers: Array<ReactTestRenderer | null> = [null, null];
  private readonly ports: [LiveGamePort, LiveGamePort];

  constructor(
    private readonly poller: BlockchainPoller,
    readonly adapters: [SessionControllerAdapter, SessionControllerAdapter],
    readonly lanes: [ReloadableSessionLane, ReloadableSessionLane],
  ) {
    this.ports = [this.portFor(0), this.portFor(1)];
  }

  state(index: number): SpacepokerHandState {
    const state = spacepokerStateCodec.decode(
      this.lanes[index].runtime.getState().model.game.handState,
    );
    assert.ok(state, `Space Poker player ${index} must have durable hand state`);
    this.reachedHandlers.add(state.gameState.handler);
    return state;
  }

  private portFor(index: number): LiveGamePort {
    return {
      isChannelReady: () => this.lanes[index].controller.isChannelReady(),
      dispatch: (intent: GameIntent) => {
        const runtime = this.lanes[index].runtime;
        const game = runtime.getState().model.game;
        if (intent.type === 'state-changed') {
          runtime.commitHandStateChanged('spacepoker');
          return;
        }
        const id = game.currentHandIds[intent.memberIndex];
        assert.ok(id, `Space Poker player ${index}: invalid member index ${intent.memberIndex}`);
        if (intent.type === 'make-move') this.submittedMoves[index] += 1;
        if (intent.type === 'accept-settlement') this.submittedSettlements[index] += 1;
        runtime.commitLocalGameAction({
          gameType: 'spacepoker',
          id,
          command:
            intent.type === 'make-move'
              ? { type: 'make-move', readable: intent.readable }
              : intent.type === 'accept-settlement'
                ? { type: 'accept-settlement' }
                : { type: 'cheat', moverShare: intent.moverShare },
        });
      },
    };
  }

  render(index: number): UseSpacepokerHandResult {
    const HookHarness = () => {
      const hand = this.lanes[index].runtime.getGameHand();
      assert.ok(hand, `Space Poker player ${index}: hook requires an active hand`);
      this.hookResults[index] = useSpacepokerHand({
        frozen: false,
        hand: hand as SpacepokerHand,
        port: this.ports[index],
        appendGameLog: () => {},
      });
      return null;
    };
    act(() => {
      if (this.renderers[index]) {
        this.renderers[index]!.update(React.createElement(HookHarness));
      } else {
        this.renderers[index] = create(React.createElement(HookHarness));
      }
    });
    const result = this.hookResults[index];
    assert.ok(result);
    return result;
  }

  private unmount(index: number): void {
    if (this.renderers[index]) {
      act(() => this.renderers[index]?.unmount());
      this.renderers[index] = null;
      this.hookResults[index] = null;
    }
  }

  async reload(index: number, label: string): Promise<void> {
    const before = structuredClone(this.state(index));
    const beforeWasm = Uint8Array.from(
      this.lanes[index].controller.getWasmFields()!.serializedGameSession,
    );
    this.unmount(index);
    this.lanes[index] = (await injectSessionReload(this.lanes[index], this.poller)).lane;
    assert.equal(this.lanes[index].controller.getRestoreStatus(), 'restored', `${label}: restore`);
    assert.deepEqual(this.state(index), before, `${label}: host hand state must round-trip`);
    assert.deepEqual(
      this.lanes[index].controller.getWasmFields()!.serializedGameSession,
      beforeWasm,
      `${label}: WASM state must round-trip`,
    );
  }

  async exchange(): Promise<void> {
    await exchangeUntilIdle(this.adapters);
    await flushWrapperDrain(this.adapters);
    for (let index = 0; index < 2; index += 1) {
      if (this.lanes[index].runtime.getState().model.game.handState !== null) {
        this.state(index);
      }
    }
  }

  async fireAutomaticAndProveSingle(index: number, label: string): Promise<void> {
    await this.reload(index, `${label} before automatic action`);
    const before = [...this.submittedMoves];
    this.render(index);
    assert.equal(
      this.submittedMoves[index],
      before[index] + 1,
      `${label}: restored hook must submit exactly one automatic move`,
    );
    await flushWrapperDrain([this.adapters[index]]);
    assert.equal(this.state(index).gameState.myTurn, false, `${label}: candidate must be durable`);
    await this.reload(index, `${label} after automatic action`);
    this.render(index);
    assert.deepEqual(
      this.submittedMoves,
      before.map((count, player) => count + (player === index ? 1 : 0)),
      `${label}: remounting the prepared candidate must not duplicate the automatic move`,
    );
    await this.exchange();
  }

  async startHand(): Promise<string> {
    const gameIds = this.lanes[0].runtime.getState().model.game.currentHandIds;
    assert.equal(gameIds.length, 1, 'Space Poker hand must have one protocol member');
    const gameId = gameIds[0];
    const commitA = [0, 1].find(
      (index) =>
        this.state(index).gameState.handler === SpHandler.CommitA &&
        this.state(index).gameState.myTurn,
    );
    assert.notEqual(commitA, undefined, 'new Space Poker hand must expose CommitA to one player');
    await this.fireAutomaticAndProveSingle(commitA!, `game ${gameId} CommitA`);

    const commitB = [0, 1].find(
      (index) =>
        this.state(index).gameState.handler === SpHandler.CommitB &&
        this.state(index).gameState.myTurn,
    );
    assert.notEqual(commitB, undefined, 'Space Poker CommitA must advance its peer to CommitB');
    await this.fireAutomaticAndProveSingle(commitB!, `game ${gameId} CommitB`);

    const pong = [0, 1].find((index) => {
      const state = this.state(index);
      return (
        state.gameState.handler === SpHandler.BeginRound &&
        state.gameState.N === 4n &&
        state.gameState.myTurn &&
        state.coinTossIOpen === false
      );
    });
    if (pong !== undefined) {
      await this.fireAutomaticAndProveSingle(pong, `game ${gameId} opening pong`);
    }
    return gameId;
  }

  async playToEnd(mode: TerminalMode): Promise<void> {
    for (let transition = 0; transition < 10; transition += 1) {
      const mover = [0, 1].find((index) => this.state(index).gameState.myTurn);
      assert.notEqual(mover, undefined, `${mode}: betting flow must have a mover`);
      const current = this.state(mover!);
      if (current.gameState.handler === SpHandler.End) {
        await this.finishAtEnd(mover!, mode);
        return;
      }
      assert.ok(
        current.gameState.handler === SpHandler.BeginRound ||
          current.gameState.handler === SpHandler.MidRound,
        `${mode}: unexpected betting handler ${current.gameState.handler}`,
      );
      await this.reload(
        mover!,
        `${mode} handler ${current.gameState.handler} N=${current.gameState.N}`,
      );
      const hook = this.render(mover!);
      act(() => {
        if (current.gameState.handler === SpHandler.BeginRound) hook.handleCheck();
        else hook.handleCall();
      });
      await flushWrapperDrain([this.adapters[mover!]]);
      await this.reload(
        mover!,
        `${mode} prepared handler ${current.gameState.handler} N=${current.gameState.N}`,
      );
      await this.exchange();
    }
    throw new Error(`${mode}: Space Poker did not reach End`);
  }

  private async finishAtEnd(index: number, mode: TerminalMode): Promise<void> {
    await this.reload(index, `${mode} End`);
    const runtime = this.lanes[index].runtime;
    const gameId = runtime.getState().model.game.currentHandIds[0];
    const hand = runtime.getGameHand() as SpacepokerHand;
    const beforeMoves = [...this.submittedMoves];
    const beforeSettlements = [...this.submittedSettlements];
    hand.update((current) => ({
      ...current,
      gameState: { handler: SpHandler.Showdown, myTurn: false, N: current.gameState.N },
      handHistory: [
        ...current.handHistory,
        { player: 'you' as const, action: mode === 'reveal' ? 'reveal' : 'concede' },
      ],
      terminalState: mode === 'reveal' ? 'revealed' : 'conceded-by-you',
    }));
    if (mode === 'reveal') {
      this.ports[index].dispatch({ type: 'make-move', memberIndex: 0, readable: null });
    } else {
      this.ports[index].dispatch({ type: 'accept-settlement', memberIndex: 0 });
    }
    await flushWrapperDrain([this.adapters[index]]);
    await this.reload(index, `${mode} prepared terminal`);
    this.render(index);
    assert.deepEqual(
      this.submittedMoves,
      beforeMoves.map((count, player) => count + (mode === 'reveal' && player === index ? 1 : 0)),
      `${mode}: terminal remount must not submit another move`,
    );
    assert.deepEqual(
      this.submittedSettlements,
      beforeSettlements.map(
        (count, player) => count + (mode === 'concede' && player === index ? 1 : 0),
      ),
      `${mode}: terminal remount must not submit another settlement`,
    );
    await this.exchange();
    for (let player = 0; player < 2; player += 1) {
      const game = this.lanes[player].runtime.getState().model.game;
      assert.equal(
        game.instances[gameId]?.presentation,
        'ended',
        `${mode}: player ${player} ended`,
      );
      assert.equal(this.state(player).gameState.handler, SpHandler.Showdown);
      await this.reload(player, `${mode} terminal player ${player}`);
    }
  }

  async nextHandSameTerms(proposer: number): Promise<string> {
    const oldIds = [...this.lanes[proposer].runtime.getState().model.game.currentHandIds];
    this.lanes[proposer].runtime.dispatch({ type: 'choose-same-terms' });
    assert.equal(this.lanes[proposer].runtime.getState().model.betweenHand.mode, 'decision');
    await this.exchange();
    const receiver = proposer ^ 1;
    const cached = this.lanes[receiver].runtime
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-cached');
    assert.ok(cached, 'same-terms receiver must cache the exact proposal');
    this.lanes[receiver].runtime.dispatch({ type: 'choose-same-terms' });
    await this.exchange();
    const newIds = this.lanes[proposer].runtime.getState().model.game.currentHandIds;
    assert.equal(newIds.length, 1);
    assert.notDeepEqual(newIds, oldIds, 'same-terms must create a new protocol game');
    assert.deepEqual(this.lanes[receiver].runtime.getState().model.game.currentHandIds, newIds);
    return newIds[0];
  }

  async foldAtFirstResponse(): Promise<void> {
    const opener = [0, 1].find((index) => {
      const state = this.state(index);
      return state.gameState.handler === SpHandler.BeginRound && state.gameState.myTurn;
    });
    assert.notEqual(opener, undefined, 'fold case must begin with an opening player');
    await this.reload(opener!, 'fold case BeginRound');
    const openingHand = this.render(opener!);
    act(() => openingHand.handleCheck());
    await this.exchange();

    const folder = opener! ^ 1;
    assert.equal(this.state(folder).gameState.handler, SpHandler.MidRound);
    assert.equal(this.state(folder).gameState.myTurn, true);
    await this.reload(folder, 'fold case MidRound');
    const foldingHand = this.render(folder);
    act(() => foldingHand.handleFold());
    await flushWrapperDrain([this.adapters[folder]]);
    await this.reload(folder, 'fold case prepared Folded');
    this.render(folder);
    await this.exchange();
    assert.equal(this.state(0).gameState.handler, SpHandler.Folded);
    assert.equal(this.state(1).gameState.handler, SpHandler.Folded);
  }

  cleanup(): void {
    this.unmount(0);
    this.unmount(1);
  }
}

async function runSpacepokerReloadCompletion(poller: BlockchainPoller): Promise<void> {
  const adapters = await createActivePair(poller, 11);
  const handProposal: HandProposal = {
    gameType: 'spacepoker',
    playerAContribution: 20n,
    playerBContribution: 20n,
    senderIsPlayerA: true,
    gameTimeout: 15n,
    parameters: 10n,
  };
  const lanes = adapters.map((adapter) => {
    const controller = adapter.blob!;
    const status = controller.lastChannelStatus;
    assert.ok(status, 'Space Poker completion lane must start Active');
    return createReloadableSessionLane(
      adapter,
      controller,
      createSessionModel({
        channel: { status: channelStatusModelFromPayload(status) },
        game: { handKey: 1 },
        betweenHand: { mode: 'compose-proposal', lastHandProposal: handProposal },
      }),
    );
  }) as [ReloadableSessionLane, ReloadableSessionLane];
  const driver = new SpacepokerReloadDriver(poller, adapters, lanes);

  try {
    lanes[0].runtime.dispatch({ type: 'submit-compose', handProposal });
    await driver.exchange();
    const review = lanes[1].runtime
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-review');
    assert.ok(review, 'Space Poker receiver must observe the real proposal');
    lanes[1].runtime.dispatch({ type: 'accept-review' });
    await driver.exchange();

    await driver.startHand();
    await driver.playToEnd('reveal');

    await driver.nextHandSameTerms(0);
    const beforeSecondStartup = [...driver.submittedMoves];
    await driver.startHand();
    assert.ok(
      driver.submittedMoves.some((count, index) => count > beforeSecondStartup[index]),
      'same-terms hand must advance through a fresh automatic commit',
    );
    await driver.playToEnd('concede');

    await driver.nextHandSameTerms(1);
    await driver.startHand();
    await driver.foldAtFirstResponse();

    assert.deepEqual(
      [...driver.reachedHandlers].sort((a, b) => Number(a - b)),
      [
        SpHandler.CommitA,
        SpHandler.CommitB,
        SpHandler.BeginRound,
        SpHandler.MidRound,
        SpHandler.End,
        SpHandler.Showdown,
        SpHandler.Folded,
      ],
      'real resumable flows must cover every Space Poker handler',
    );
  } finally {
    driver.cleanup();
  }
}

it(
  'completes and reloads every reachable real-WASM Space Poker state',
  async () => {
    try {
      const poller = await startSimulator(['cafe00011', 'dead00011']);
      if (!poller) return;
      await runSpacepokerReloadCompletion(poller);
    } catch (error) {
      throw new Error(`[load_wasm Space Poker reload completion failed]\n${String(error)}`, {
        cause: error,
      });
    }
  },
  300 * 1000,
);
