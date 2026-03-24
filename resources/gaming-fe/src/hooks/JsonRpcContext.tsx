import { ChiaMethod } from '../constants/wallet-connect';
import {
  CreateOfferForIdsRequest,
  CreateOfferForIdsResponse,
} from '../types/rpc/CreateOfferForIds';
import {
  GetCurrentAddressRequest,
  GetCurrentAddressResponse,
} from '../types/rpc/GetCurrentAddress';
import {
  GetWalletBalanceRequest,
  GetWalletBalanceResponse,
} from '../types/rpc/GetWalletBalance';
import {
  SendTransactionRequest,
  SendTransactionResponse,
} from '../types/rpc/SendTransaction';
import {
  GetHeightInfoRequest,
  GetHeightInfoResponse,
} from '../types/rpc/GetHeightInfo';
import {
  CreateNewRemoteWalletRequest,
  CreateNewRemoteWalletResponse,
} from '../types/rpc/CreateNewRemoteWallet';
import {
  RegisterRemoteCoinsRequest,
  RegisterRemoteCoinsResponse,
} from '../types/rpc/RegisterRemoteCoins';
import {
  GetCoinRecordsByNamesRequest,
  GetCoinRecordsByNamesResponse,
} from '../types/rpc/GetCoinRecordsByNames';
import {
  PushTxRequest,
  PushTxResponse,
} from '../types/rpc/PushTx';
import {
  SelectCoinsRequest,
  SelectCoinsResponse,
} from '../types/rpc/SelectCoins';

import { walletConnectState } from './useWalletConnect';

type Loose = Record<string, unknown>;
type AddCatTokenRequest = Loose;
type AddCatTokenResponse = Loose;
type CancelOfferRequest = Loose;
type CancelOfferResponse = Loose;
type CheckOfferValidityRequest = Loose;
type CheckOfferValidityResponse = Loose;
type CreateNewCatWalletRequest = Loose;
type CreateNewCatWalletResponse = Loose;
type CreateNewDidWalletRequest = Loose;
type CreateNewDidWalletResponse = Loose;
type GetAllOffersRequest = Loose;
type GetAllOffersResponse = Loose;
type GetCatAssetIdRequest = Loose;
type GetCatAssetIdResponse = Loose;
type GetCatWalletInfoRequest = Loose;
type GetCatWalletInfoResponse = Loose;
type GetNextAddressRequest = Loose;
type GetNextAddressResponse = Loose;
type GetNftInfoRequest = Loose;
type GetNftInfoResponse = Loose;
type GetNftWalletsWithDidsRequest = Loose;
type GetNftWalletsWithDidsResponse = Loose;
type GetNftsRequest = Loose;
type GetNftsResponse = Loose;
type GetNftsCountRequest = Loose;
type GetNftsCountResponse = Loose;
type GetOfferDataRequest = Loose;
type GetOfferDataResponse = Loose;
type GetOfferRecordRequest = Loose;
type GetOfferRecordResponse = Loose;
type GetOfferSummaryRequest = Loose;
type GetOfferSummaryResponse = Loose;
type GetOffersCountRequest = Loose;
type GetOffersCountResponse = Loose;
type GetSyncStatusRequest = Loose;
type GetSyncStatusResponse = Loose;
type GetTransactionRequest = Loose;
type GetTransactionResponse = Loose;
type GetWalletAddressesRequest = Loose;
type GetWalletAddressesResponse = Loose;
type GetWalletsRequest = Loose;
type GetWalletsResponse = Array<{ id: number; type: number; [key: string]: unknown }>;
type LogInRequest = Loose;
type LogInResponse = Loose;
type MintNftRequest = Loose;
type MintNftResponse = Loose;
type SetDidNameRequest = Loose;
type SetDidNameResponse = Loose;
type SetNftDidRequest = Loose;
type SetNftDidResponse = Loose;
type SignMessageByAddressRequest = Loose;
type SignMessageByAddressResponse = Loose;
type SignMessageByIdRequest = Loose;
type SignMessageByIdResponse = Loose;
type SpendCatRequest = Loose;
type SpendCatResponse = Loose;
type TakeOfferRequest = Loose;
type TakeOfferResponse = Loose;
type TransferNftRequest = Loose;
type TransferNftResponse = Loose;
type VerifySignatureRequest = Loose;
type VerifySignatureResponse = Loose;

interface _JsonRpc {
  // Wallet
  logIn: (data: LogInRequest) => Promise<LogInResponse>;
  getWallets: (data: GetWalletsRequest) => Promise<GetWalletsResponse>;
  getTransaction: (
    data: GetTransactionRequest,
  ) => Promise<GetTransactionResponse>;
  getWalletBalance: (
    data: GetWalletBalanceRequest,
  ) => Promise<GetWalletBalanceResponse>;
  signMessageById: (
    data: SignMessageByIdRequest,
  ) => Promise<SignMessageByIdResponse>;
  getCurrentAddress: (
    data: GetCurrentAddressRequest,
  ) => Promise<GetCurrentAddressResponse>;
  sendTransaction: (
    data: SendTransactionRequest,
  ) => Promise<SendTransactionResponse>;
  signMessageByAddress: (
    data: SignMessageByAddressRequest,
  ) => Promise<SignMessageByAddressResponse>;
  verifySignature: (
    data: VerifySignatureRequest,
  ) => Promise<VerifySignatureResponse>;
  getNextAddress: (
    data: GetNextAddressRequest,
  ) => Promise<GetNextAddressResponse>;
  getSyncStatus: (data: GetSyncStatusRequest) => Promise<GetSyncStatusResponse>;
  getWalletAddresses: (
    data: GetWalletAddressesRequest,
  ) => Promise<GetWalletAddressesResponse>;

  // Offers
  getAllOffers: (data: GetAllOffersRequest) => Promise<GetAllOffersResponse>;
  getOffersCount: (
    data: GetOffersCountRequest,
  ) => Promise<GetOffersCountResponse>;
  createOfferForIds: (
    data: CreateOfferForIdsRequest,
  ) => Promise<CreateOfferForIdsResponse>;
  cancelOffer: (data: CancelOfferRequest) => Promise<CancelOfferResponse>;
  checkOfferValidity: (
    data: CheckOfferValidityRequest,
  ) => Promise<CheckOfferValidityResponse>;
  takeOffer: (data: TakeOfferRequest) => Promise<TakeOfferResponse>;
  getOfferSummary: (
    data: GetOfferSummaryRequest,
  ) => Promise<GetOfferSummaryResponse>;
  getOfferData: (data: GetOfferDataRequest) => Promise<GetOfferDataResponse>;
  getOfferRecord: (
    data: GetOfferRecordRequest,
  ) => Promise<GetOfferRecordResponse>;

  // CATs
  createNewCatWallet: (
    data: CreateNewCatWalletRequest,
  ) => Promise<CreateNewCatWalletResponse>;
  getCatWalletInfo: (
    data: GetCatWalletInfoRequest,
  ) => Promise<GetCatWalletInfoResponse>;
  getCatAssetId: (data: GetCatAssetIdRequest) => Promise<GetCatAssetIdResponse>;
  spendCat: (data: SpendCatRequest) => Promise<SpendCatResponse>;
  addCatToken: (data: AddCatTokenRequest) => Promise<AddCatTokenResponse>;

  // NFTs
  getNfts: (data: GetNftsRequest) => Promise<GetNftsResponse>;
  getNftInfo: (data: GetNftInfoRequest) => Promise<GetNftInfoResponse>;
  mintNft: (data: MintNftRequest) => Promise<MintNftResponse>;
  transferNft: (data: TransferNftRequest) => Promise<TransferNftResponse>;
  getNftsCount: (data: GetNftsCountRequest) => Promise<GetNftsCountResponse>;

  // DIDs
  createNewDidWallet: (
    data: CreateNewDidWalletRequest,
  ) => Promise<CreateNewDidWalletResponse>;
  setDidName: (data: SetDidNameRequest) => Promise<SetDidNameResponse>;
  setNftDid: (data: SetNftDidRequest) => Promise<SetNftDidResponse>;
  getNftWalletsWithDids: (
    data: GetNftWalletsWithDidsRequest,
  ) => Promise<GetNftWalletsWithDidsResponse>;

  // Blockchain (remote wallet)
  selectCoins: (
    data: SelectCoinsRequest,
  ) => Promise<SelectCoinsResponse>;
  getHeightInfo: (
    data: GetHeightInfoRequest,
  ) => Promise<GetHeightInfoResponse>;
  createNewRemoteWallet: (
    data: CreateNewRemoteWalletRequest,
  ) => Promise<CreateNewRemoteWalletResponse>;
  registerRemoteCoins: (
    data: RegisterRemoteCoinsRequest,
  ) => Promise<RegisterRemoteCoinsResponse>;
  getCoinRecordsByNames: (
    data: GetCoinRecordsByNamesRequest,
  ) => Promise<GetCoinRecordsByNamesResponse>;
  pushTx: (data: PushTxRequest) => Promise<PushTxResponse>;
  walletPushTx: (data: PushTxRequest) => Promise<PushTxResponse>;
}

async function request<T, D extends object = object>(
  method: ChiaMethod,
  data: D,
): Promise<T> {
  if (!walletConnectState.getClient())
    throw new Error('WalletConnect is not initialized');
  if (!walletConnectState.getSession())
    throw new Error('Session is not connected');

  const address = walletConnectState.getAddress();
  if (!address) {
    throw new Error('no fingerprint set in walletconnect');
  }

  const params: Record<string, unknown> = {
    ...data,
    fingerprint: Number.parseInt(address, 10),
  };

  console.log('[WC] >>>', method, params);

  const raw = await walletConnectState.getClient()!.request({
    topic: walletConnectState.getSession()!.topic,
    chainId: walletConnectState.getChainId(),
    request: { method, params },
  });

  console.log('[WC] <<<', method, raw);

  const result = raw as Record<string, unknown> | undefined;
  if (result?.error) throw new Error(JSON.stringify(result.error));

  return (result?.data ?? result) as T;
}

async function logIn(data: LogInRequest) {
  return await request<LogInResponse>(ChiaMethod.LogIn, data);
}

async function getWallets(data: GetWalletsRequest) {
  return await request<GetWalletsResponse>(ChiaMethod.GetWallets, data);
}

async function getTransaction(data: GetTransactionRequest) {
  return await request<GetTransactionResponse>(ChiaMethod.GetTransaction, data);
}

async function getWalletBalance(data: GetWalletBalanceRequest) {
  return await request<GetWalletBalanceResponse>(
    ChiaMethod.GetWalletBalance,
    data,
  );
}

async function getCurrentAddress(data: GetCurrentAddressRequest) {
  return await request<GetCurrentAddressResponse>(
    ChiaMethod.GetCurrentAddress,
    data,
  );
}

async function sendTransaction(data: SendTransactionRequest) {
  return await request<SendTransactionResponse>(
    ChiaMethod.SendTransaction,
    data,
  );
}

async function signMessageById(data: SignMessageByIdRequest) {
  return await request<SignMessageByIdResponse>(
    ChiaMethod.SignMessageById,
    data,
  );
}

async function signMessageByAddress(data: SignMessageByAddressRequest) {
  return await request<SignMessageByAddressResponse>(
    ChiaMethod.SignMessageByAddress,
    data,
  );
}

async function verifySignature(data: VerifySignatureRequest) {
  return await request<VerifySignatureResponse>(
    ChiaMethod.VerifySignature,
    data,
  );
}

async function getNextAddress(data: GetNextAddressRequest) {
  return await request<GetNextAddressResponse>(ChiaMethod.GetNextAddress, data);
}

async function getSyncStatus(data: GetSyncStatusRequest) {
  return await request<GetSyncStatusResponse>(ChiaMethod.GetSyncStatus, data);
}

async function getWalletAddresses(data: GetWalletAddressesRequest) {
  return await request<GetWalletAddressesResponse>(
    ChiaMethod.GetWalletAddresses,
    data,
  );
}

// Offers

async function getAllOffers(data: GetAllOffersRequest) {
  return await request<GetAllOffersResponse>(ChiaMethod.GetAllOffers, data);
}

async function getOffersCount(data: GetOffersCountRequest) {
  return await request<GetOffersCountResponse>(ChiaMethod.GetOffersCount, data);
}

async function createOfferForIds(data: CreateOfferForIdsRequest) {
  return await request<CreateOfferForIdsResponse>(
    ChiaMethod.CreateOfferForIds,
    data,
  );
}

async function cancelOffer(data: CancelOfferRequest) {
  return await request<CancelOfferResponse>(ChiaMethod.CancelOffer, data);
}

async function checkOfferValidity(data: CheckOfferValidityRequest) {
  return await request<CheckOfferValidityResponse>(
    ChiaMethod.CheckOfferValidity,
    data,
  );
}

async function takeOffer(data: TakeOfferRequest) {
  return await request<TakeOfferResponse>(ChiaMethod.TakeOffer, data);
}

async function getOfferSummary(data: GetOfferSummaryRequest) {
  return await request<GetOfferSummaryResponse>(
    ChiaMethod.GetOfferSummary,
    data,
  );
}

async function getOfferData(data: GetOfferDataRequest) {
  return await request<GetOfferDataResponse>(ChiaMethod.GetOfferData, data);
}

async function getOfferRecord(data: GetOfferRecordRequest) {
  return await request<GetOfferRecordResponse>(ChiaMethod.GetOfferRecord, data);
}

// CATs

async function createNewCatWallet(data: CreateNewCatWalletRequest) {
  return await request<CreateNewCatWalletResponse>(
    ChiaMethod.CreateNewCatWallet,
    data,
  );
}

async function getCatWalletInfo(data: GetCatWalletInfoRequest) {
  return await request<GetCatWalletInfoResponse>(
    ChiaMethod.GetCatWalletInfo,
    data,
  );
}

async function getCatAssetId(data: GetCatAssetIdRequest) {
  return await request<GetCatAssetIdResponse>(ChiaMethod.GetCatAssetId, data);
}

async function spendCat(data: SpendCatRequest) {
  return await request<SpendCatResponse>(ChiaMethod.SpendCat, data);
}

async function addCatToken(data: AddCatTokenRequest) {
  return await request<AddCatTokenResponse>(ChiaMethod.AddCatToken, data);
}

// NFTs
async function getNfts(data: GetNftsRequest) {
  return await request<GetNftsResponse>(ChiaMethod.GetNfts, data);
}

async function getNftInfo(data: GetNftInfoRequest) {
  return await request<GetNftInfoResponse>(ChiaMethod.GetNftInfo, data);
}

async function mintNft(data: MintNftRequest) {
  return await request<MintNftResponse>(ChiaMethod.MintNft, data);
}

async function transferNft(data: TransferNftRequest) {
  return await request<TransferNftResponse>(ChiaMethod.TransferNft, data);
}

async function getNftsCount(data: GetNftsCountRequest) {
  return await request<GetNftsCountResponse>(ChiaMethod.GetNftsCount, data);
}

// DIDs

async function createNewDidWallet(data: CreateNewDidWalletRequest) {
  return await request<CreateNewDidWalletResponse>(
    ChiaMethod.CreateNewDidWallet,
    data,
  );
}

async function setDidName(data: SetDidNameRequest) {
  return await request<SetDidNameResponse>(ChiaMethod.SetDidName, data);
}

async function setNftDid(data: SetNftDidRequest) {
  return await request<SetNftDidResponse>(ChiaMethod.SetNftDid, data);
}

async function getNftWalletsWithDids(data: GetNftWalletsWithDidsRequest) {
  return await request<GetNftWalletsWithDidsResponse>(
    ChiaMethod.GetNftWalletsWithDids,
    data,
  );
}

// Blockchain (remote wallet)

async function selectCoins(data: SelectCoinsRequest) {
  return await request<SelectCoinsResponse>(ChiaMethod.SelectCoins, data);
}

async function getHeightInfo(data: GetHeightInfoRequest) {
  return await request<GetHeightInfoResponse>(ChiaMethod.GetHeightInfo, data);
}

async function createNewRemoteWallet(data: CreateNewRemoteWalletRequest) {
  return await request<CreateNewRemoteWalletResponse>(
    ChiaMethod.CreateNewRemoteWallet,
    data,
  );
}

async function registerRemoteCoins(data: RegisterRemoteCoinsRequest) {
  return await request<RegisterRemoteCoinsResponse>(
    ChiaMethod.RegisterRemoteCoins,
    data,
  );
}

async function getCoinRecordsByNames(data: GetCoinRecordsByNamesRequest) {
  return await request<GetCoinRecordsByNamesResponse>(
    ChiaMethod.GetCoinRecordsByNames,
    data,
  );
}

async function pushTx(data: PushTxRequest) {
  return await request<PushTxResponse>(ChiaMethod.PushTx, data);
}

async function walletPushTx(data: PushTxRequest) {
  return await request<PushTxResponse>(ChiaMethod.WalletPushTx, data);
}

export const rpc = {
  // Wallet
  logIn,
  getWallets,
  getTransaction,
  getWalletBalance,
  getCurrentAddress,
  sendTransaction,
  signMessageById,
  signMessageByAddress,
  verifySignature,
  getNextAddress,
  getSyncStatus,
  getWalletAddresses,

  // Offers
  getAllOffers,
  getOffersCount,
  createOfferForIds,
  cancelOffer,
  checkOfferValidity,
  takeOffer,
  getOfferSummary,
  getOfferData,
  getOfferRecord,

  // CATs
  createNewCatWallet,
  getCatWalletInfo,
  getCatAssetId,
  spendCat,
  addCatToken,

  // NFTs
  getNfts,
  getNftInfo,
  mintNft,
  transferNft,
  getNftsCount,

  // DIDs
  createNewDidWallet,
  setDidName,
  setNftDid,
  getNftWalletsWithDids,

  // Blockchain (remote wallet)
  selectCoins,
  getHeightInfo,
  createNewRemoteWallet,
  registerRemoteCoins,
  getCoinRecordsByNames,
  pushTx,
  walletPushTx,
};
