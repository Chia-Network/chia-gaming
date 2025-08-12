import asyncio
import binascii
import os
from pathlib import Path

from chia.rpc.wallet_rpc_client import WalletRpcClient

from chia.util.config import load_config, save_config
from chia.util.hash import std_hash

from chia.wallet.util.tx_config import DEFAULT_TX_CONFIG

wallet_rpc_port = 9256
rpc_host = 'localhost'

from flask import Flask, request
app = Flask(__name__)

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

    try:
        transaction_result = await wallet_rpc_client.send_transaction(
            wallet_id,
            amount,
            target,
            DEFAULT_TX_CONFIG
        )
        transaction_result['success'] = True
        return transaction_result
    except Exception as e:
        print('exception', e)
        return {'error': str(e)}

@app.route('/send_transaction', methods = ['POST'])
async def send_transaction_service():
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
