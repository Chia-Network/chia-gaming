import { Subject } from 'rxjs';

export const blockFeed = new Subject();

export function blockchainUpdate() {
  return fetch('http://localhost:5800/wait_block', { method: 'POST' })
    .then((res: Response) => res.json())
    .then((blockNumber: unknown) => {
      blockFeed.next({
        height: blockNumber as number,
      });
    })
    .then(() => {
      setTimeout(() => {
        return blockchainUpdate();
      }, 5000);
    });
}

export interface BlockSpends {
  spends: unknown[];
}

export function get_block_spends(header_hash: string) {
  return fetch(
    `http://localhost:5800/block_spends?header_hash=${header_hash}`,
    { method: 'POST' },
  )
    .then((res: Response) => res.json())
    .then((value: unknown) => {
      return value as BlockSpends;
    });
}

export function get_current_peak() {
  // https://www.coinset.org/docs/usage/full--node/get_blockchain_state
  return fetch(
    `http://localhost:5800/get_blockchain_state`,
    { method: 'POST' },
  )
    .then((res: Response) => res.json())
    .then((value: unknown) => {
      return value;
    });
}

export interface PushTxBody {
  spend_bundle: unknown;
}
type SimulatorPushTxResult = (number | undefined)[];
interface PushTxResult {
  error?: string;
  success?: string;
}

export async function simulatorPushTx(body: PushTxBody): Promise<PushTxResult> {
  const lower_result = await fetch(`http://localhost:5800/push_tx`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
    .then((res: Response) => res.json())
    .then((value: unknown) => {
      return value as SimulatorPushTxResult;
    });
  let result: PushTxResult = { error: JSON.stringify(lower_result) };
  if (lower_result[0] === 1) {
    result = { success: 'SUCCESS' };
  } else if (lower_result[1] === 6) {
    result = { error: 'UNKNOWN_UNSPENT' };
  }
  return result;
}
