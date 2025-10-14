import { Application, Request, Response } from 'express';
import { WebSocket } from 'ws';

import { PushTxBody, blockFeed, get_block_spends, simulatorPushTx } from './blockchain';

type NewWebSocket = (ws: WebSocket, req: Request) => void;
export interface ApplicationWithWebSocket {
  ws: (path: string, definition: NewWebSocket) => void;
}
interface HasHeight {
  height: number;
}
interface HasHeaderHash {
  header_hash: string;
}

export function bindBlockchain(app: Application) {
  app.post('/get_block_record_by_height', (req: Request, res: Response) => {
    const { height } = req.body as HasHeight;
    console.log('get block record', height);
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify({ block_record: { height, header_hash: height } }));
  });

  app.post('/get_block_spends', async (req: Request, res: Response) => {
    // Really the height.
    const { header_hash } = req.body as HasHeaderHash;
    const result = await get_block_spends(header_hash);
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify(result));
  });

  app.post('/push_tx', async (req: Request, res: Response) => {
    const body = req.body as PushTxBody;
    console.log(`push_tx body ${JSON.stringify(body)}`);
    const result = await simulatorPushTx(body);
    res.set('Content-Type', 'application/json');
    console.log(`push_tx result = ${JSON.stringify(result)}`);
    res.send(JSON.stringify(result));
  });

  ((app as unknown) as ApplicationWithWebSocket).ws('/ws', (ws: WebSocket, _req: Request) => {
    const sub = blockFeed.subscribe({
      next: (peak) => ws.send(JSON.stringify({ type: 'peak', data: peak })),
    });
    ws.on('close', () => sub.unsubscribe());
  });
}
