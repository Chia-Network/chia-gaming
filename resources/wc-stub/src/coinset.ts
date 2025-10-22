import { Subject } from 'rxjs';

const blockFeed = new Subject();

export function blockchainUpdate(): () => void {
  let active = true;

  const poll = async () => {
    if (!active) return;

    try {
      const res = await fetch('http://localhost:5800/wait_block', {
        method: 'POST',
      });
      const blockNumber = await res.json();
      blockFeed.next({ height: blockNumber });
    } catch (error) {
      console.error('Blockchain update failed:', error);
    }

    if (active) {
      setTimeout(poll, 5000);
    }
  };

  poll();

  return () => {
    active = false;
  };
}

export function bindBlockchain(app: any) {
  app.post('/get_block_record_by_height', async (req: any, res: any) => {
    const { height } = req.body;
    console.log('get block record', height);
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify({ block_record: { height, header_hash: height } }));
  });

  app.post('/get_block_spends', async (req: any, res: any) => {
    // Really the height.
    let { header_hash } = req.body;
    const result = await fetch(
      `http://localhost:5800/block_spends?header_hash=${header_hash}`,
      { method: 'POST' },
    ).then((res) => res.json());
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify(result));
  });

  app.post('/push_tx', async (req: any, res: any) => {
    const body = req.body;
    console.log(`push_tx body ${JSON.stringify(body)}`);
    const lower_result: (number | undefined)[] = await fetch(
      `http://localhost:5800/push_tx`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      },
    ).then((res: any) => res.json());
    res.set('Content-Type', 'application/json');
    console.log(`push_tx result = ${JSON.stringify(lower_result)}`);
    let result: any = { error: JSON.stringify(lower_result) };
    if (lower_result[0] === 1) {
      result = { success: 'SUCCESS' };
    } else if (lower_result[1] === 6) {
      result = { error: 'UNKNOWN_UNSPENT' };
    }

    res.send(JSON.stringify(result));
  });

  app.ws('/ws', (ws: any, req: any) => {
    const sub = blockFeed.subscribe({
      next: (peak) => ws.send(JSON.stringify({ type: 'peak', data: peak })),
    });
    ws.on('close', () => sub.unsubscribe());
  });
}
