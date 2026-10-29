import { getGenesisChallenge } from '../../constants/wallet-connect';
import { log } from '../../services/log';
import { PeerConnectionResult, type WasmConnection } from '../../types/ChiaGaming';
import { coerceToBytes } from '../../util';
import type { SessionWallet } from '../wallet/sessionWallet';
import { channelFundingRuntime } from './channelFundingRuntime';
import {
  recentDiagnosticEntries,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';
import { type RehydratedDurableApplicationState } from './persistence';
import { SessionController } from './SessionController';

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`restoreSession: missing or invalid ${label}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`restoreSession: missing or invalid ${label}`);
}

export async function configSessionController(
  sc: SessionController,
  iStarted: boolean,
  wasmConnection: WasmConnection,
  blockchain: SessionWallet,
  channelTimeout?: number,
  unrollTimeout?: number,
  rewardPuzzleHashOverride?: string,
): Promise<SessionController> {
  sc.loadWasm(wasmConnection);
  const peer = sc.getPeerProtocol();
  const result = await peer.open_channel(
    {
      proposer_amount: (iStarted ? sc.myContribution : sc.theirContribution).toString(),
      responder_amount: (iStarted ? sc.theirContribution : sc.myContribution).toString(),
      channel_timeout: channelTimeout?.toString(),
      unroll_timeout: unrollTimeout?.toString(),
    },
    iStarted,
    getGenesisChallenge(),
    async () => rewardPuzzleHashOverride ?? (await blockchain.rpc.getAddress()).puzzleHash,
  );
  if (!result) return sc;
  sc.rewardPuzzleHash = result.rewardPuzzleHash;
  sc.emitRewardAddress();
  sc.setGameSession(peer);
  sc.attachBlockchain(blockchain);
  log('[wasm] activateSpend');
  sc.activateSpend();
  log('[wasm] session controller configured (handshake)');
  return sc;
}

export async function restoreSession(
  sc: SessionController,
  bootstrap: RehydratedDurableApplicationState,
  wasmConnection: WasmConnection,
): Promise<void> {
  if (bootstrap.state.session?.phase !== 'live') {
    throw new Error('restoreSession requires a live durable session');
  }
  const save = bootstrap.state;
  const session = bootstrap.state.session;
  sc.loadWasm(wasmConnection);
  const currentSchema = BigInt(wasmConnection.game_session_serialization_schema());
  if (session.live.gameSessionSchemaVersion !== currentSchema) {
    const savedSchema = session.live.gameSessionSchemaVersion.toString();
    throw new Error(
      `Unsupported saved game format: cradle schema ${savedSchema}; current schema is ${currentSchema}`,
    );
  }

  const cradleBytes =
    session.live.serializedGameSession instanceof Uint8Array
      ? session.live.serializedGameSession
      : (() => {
          throw new Error('restoreSession serializedGameSession must be a Uint8Array');
        })();

  if (sc.getGameSessionId() !== session.pairing.gameSessionId) {
    throw new Error('restoreSession: reliable session id does not match persisted pairing');
  }
  sc.restoreTransportCheckpoint(session.live);
  const cradle = sc.getPeerProtocol();
  cradle.restore_channel(cradleBytes);
  sc.iStarted = requireBoolean(session.pairing.iStarted, 'iStarted');
  sc.pairingToken = requireString(session.pairing.token, 'pairingToken');
  if (session.live.disposition !== 'active') {
    throw new Error('restoreSession: live reliable transport is not active');
  }
  sc.wasmNotificationHistory = recentEntries(
    save.history.wasmNotificationHistory ?? [],
    WASM_NOTIFICATION_HISTORY_LIMIT,
  );
  sc.diagnosticLog = recentDiagnosticEntries(save.history.diagnosticLog ?? []);
  sc.restorePresentationTiming({
    waitingStateEnteredAt: session.presentation.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: session.presentation.cleanShutdownGraceStartedAt,
  });
  sc.restoreChannelStatus(
    session.presentation.channelStatus
      ? {
          ...session.presentation.channelStatus,
          coin: coerceToBytes(session.presentation.channelStatus.coin),
        }
      : null,
  );
  sc.myAlias = session.pairing.myAlias;
  sc.opponentAlias = session.pairing.opponentAlias;
  if (!session.live.rewardPuzzleHash) {
    throw new Error('restoreSession: missing rewardPuzzleHash in persisted session');
  }
  sc.rewardPuzzleHash = session.live.rewardPuzzleHash;
  sc.setGameSession(cradle);

  log('[restore] session restored');
}

export function createSessionController(
  blockchain: SessionWallet | null,
  peerConn: PeerConnectionResult,
  uniqueId: string,
  myContribution: bigint,
  theirContribution: bigint,
  iStarted: boolean,
  sessionBootstrap?: RehydratedDurableApplicationState,
  pairingToken?: string,
  perGameAmount?: bigint,
  getFee?: () => bigint,
): SessionController {
  const sessionController = new SessionController(
    blockchain,
    uniqueId,
    myContribution,
    theirContribution,
    peerConn,
    channelFundingRuntime,
    sessionBootstrap?.state.walletContext ?? undefined,
  );
  if (sessionBootstrap?.state.session?.phase === 'live') {
    sessionController.restoreTransportCheckpoint(sessionBootstrap.state.session.live);
  }
  sessionController.iStarted = iStarted;
  sessionController.pairingToken = pairingToken ?? '';
  sessionController.perGameAmount = perGameAmount ?? 0n;
  if (getFee) sessionController.getFee = getFee;
  sessionController.setPeerKeepalive(() => peerConn.sendKeepalive());

  sessionController.initializeExecution(
    sessionBootstrap?.state.session?.phase === 'live',
    sessionBootstrap,
  );
  sessionController.kickSystem(2);

  return sessionController;
}
