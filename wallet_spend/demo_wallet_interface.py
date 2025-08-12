import asyncio
import binascii
import os
import json
from pathlib import Path

from chia.rpc.wallet_rpc_client import WalletRpcClient

from chia.util.config import load_config, save_config
from chia.util.hash import std_hash

from chia.wallet.util.tx_config import DEFAULT_TX_CONFIG

wallet_rpc_port = 9256
rpc_host = 'localhost'

from flask import Flask, request
from flask_cors import CORS
app = Flask(__name__)
CORS(app)

async def get_rpc_conn():
    root_dir = os.environ['CHIA_ROOT'] if 'CHIA_ROOT' in os.environ \
        else os.path.join(
                os.environ['HOME'], '.chia/mainnet'
        )

    config = load_config(Path(root_dir), 'config.yaml')

    wallet_rpc_client = await WalletRpcClient.create(
        rpc_host, wallet_rpc_port, Path(root_dir), config
    )

    return wallet_rpc_client

async def find_associated_wallet(public_key):
    return 1

async def select_wallet_send_transaction(
        wallet_rpc_client,
        public_key,
        target,
        amount
):
    # Find the wallet id associated with the given public key
    wallet_id = await find_associated_wallet(public_key)

    while True:
        sync_status = await wallet_rpc_client.get_sync_status()
        sync_status_json = eval(str(sync_status))
        print('waiting for sync', sync_status_json)
        if sync_status_json['synced']:
            break

        await asyncio.sleep(0.2)

    try:
        transaction_result = await wallet_rpc_client.send_transaction(
            wallet_id,
            amount,
            target,
            DEFAULT_TX_CONFIG
        )
        transaction_json = eval(str(transaction_result))
        for a in transaction_json['transaction']['additions']:
            a['parentCoinInfo'] = a['parent_coin_info']
            a['puzzleHash'] = a['puzzle_hash']
        transaction_json['success'] = True
        return transaction_json
    except Exception as e:
        print('exception', e)
        return {'error': str(e)}

@app.route('/get_current_address', methods = ['POST', 'OPTIONS'])
async def get_address():
    rpc_client = await get_rpc_conn()
    get_address = await rpc_client.get_next_address(1, False)
    return json.dumps(get_address)

    

@app.route('/send_transaction', methods = ['POST', 'OPTIONS'])
async def send_transaction_service():
    if request.method == 'OPTIONS':
        return ''

    rpc_client = await get_rpc_conn()
    who = request.args.get('who')
    target = request.args.get('target')
    amount = request.args.get('amount')
    result = await select_wallet_send_transaction(
        rpc_client,
        who,
        target,
        int(amount)
    )
    rpc_client.close()
    return result

if __name__ == '__main__':
    print('local wallet connection on port 3002')
    app.run(port=3002)
