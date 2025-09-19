import { Subject } from 'rxjs';

const blockFeed = new Subject();

export function blockchainUpdate() {
  return fetch("http://localhost:5800/wait_block", {method: "POST"}).then((res: any) => res.json()).then((blockNumber: number) => {
    blockFeed.next({
      height: blockNumber,
    });
  }).then(() => {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        return blockchainUpdate();
      }, 5000);
    });
  });
}

export function bindBlockchain(app: any) {
  app.post('/get_block_record_by_height', async (req: any, res: any) => {
    const { height } = req.body;
    console.log('get block record', height);
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify({ block_record: { header_hash: height } }));
  });

  app.post('/get_block_spends', async (req: any, res: any) => {
    // Really the height.
    let { header_hash } = req.body;
    const result = await fetch(`http://localhost:5800/block_spends?header_hash=${header_hash}`, {method: "POST"});
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify(result));
  });

  app.post('/push_tx', async (req: any, res: any) => {
    const body = req.body;
    const lower_result: (number | undefined)[] = await fetch(`http://localhost:5800/push_tx?spend=${JSON.stringify(body)}`, {
      method: "POST"
    }).then((res: any) => res.json());
    res.set('Content-Type', 'application/json');
    let result: any = {error: JSON.stringify(lower_result)};
    if (lower_result[0] === 1) {
      result = {success: "SUCCESS"};
    } else if (lower_result[1] === 6) {
      result = {error: "UNKNOWN_UNSPENT"};
    }

    res.send(JSON.stringify(result));
  });

  app.ws('/ws', (ws: any, req: any) => {
    const sub = blockFeed.subscribe({
      next: (peak) => ws.send(JSON.stringify({ type: "peak", data: peak }))
    });
    ws.on('close', () => sub.unsubscribe());
  });
}
