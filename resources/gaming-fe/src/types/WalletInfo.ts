import { WalletType } from './WalletType';

interface BaseWalletInfo {
    id: number;
    name: string;
    data: string;
}

interface CatWalletInfo extends BaseWalletInfo {
    type: WalletType.Cat;
    meta: {
        assetId: string;
        name: string;
    };
}

interface NftWalletInfo extends BaseWalletInfo {
    type: WalletType.Nft;
    meta: {
        did: string;
    };
}

interface OtherWalletInfo extends BaseWalletInfo {
    type: Exclude<WalletType, WalletType.Cat | WalletType.Nft>;
    meta: {};
}

export type WalletInfo = CatWalletInfo | NftWalletInfo | OtherWalletInfo;
