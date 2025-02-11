import { WalletType } from '../WalletType';

export interface CreateNewCatWalletRequest {
    amount: number;
    fee: number;
}

export interface CreateNewCatWalletResponse {
    assetId: string;
    type: WalletType.Cat;
    walletId: number;
    success: true;
}
