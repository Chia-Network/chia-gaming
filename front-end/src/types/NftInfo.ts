export interface NftInfo {
  nftId: string;
  launcherId: string;
  nftCoinId: string;
  nftCoinConfirmationHeight: number;
  ownerDid: string | null;
  royaltyPercentage: number | null;
  royaltyPuzzleHash: string | null;
  dataUris: string[];
  dataHash: string;
  metadataUris: string[];
  metadataHash: string;
  licenseUris: string[];
  licenseHash: string;
  editionTotal: number;
  editionNumber: number;
  updaterPuzhash: string;
  chainInfo: string;
  mintHeight: number;
  supportsDid: boolean;
  p2Address: string;
  pendingTransaction: boolean;
  minterDid: string | null;
  launcherPuzhash: string;
  offChainMetadata: string | null;
}
