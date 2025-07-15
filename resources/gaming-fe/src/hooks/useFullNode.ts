export class BlockchainInterface {
  baseUrl: string;
  fingerprint?: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async init(): Promise<void> {
    // coinset.org:
    // Do get_blockchain_state
    // then get_block_record_by_height
  }

  async getFingerprints(): Promise<string[]> {
    throw 'no';
  }

  async setFingerprint(fp: string): Promise<never[]> {
    throw 'no';
  }

  async getBalance(): Promise<string> {
    throw 'no';
  }

  async get_peak(): Promise<number> {
    return fetch(`${this.baseUrl}/get_blockchain_state`, {
      method: 'POST'
    }).then(res => res.json()).then(json => {
      return json.blockchain_state.peak.height;
    });
  }

  async create_spendable(target: string, amt: number): Promise<string> {
    window.parent.postMessage({
      name: 'create_spendable',
      target: target,
      amt: amt
    }, '*');
    throw 'no';
  }
}

let blockchainInterfaceSingleton: any = null;

export function getBlockchainInterfaceSingleton() {
  if (blockchainInterfaceSingleton) {
    return blockchainInterfaceSingleton;
  }

  blockchainInterfaceSingleton = new BlockchainInterface("https://api.coinset.org");
  return blockchainInterfaceSingleton;
}
