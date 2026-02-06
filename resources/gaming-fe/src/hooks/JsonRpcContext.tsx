import { ChiaMethod } from '../constants/wallet-connect';
import {
  AddCatTokenRequest,
  AddCatTokenResponse,
} from '../types/rpc/AddCatToken';
import {
  CancelOfferRequest,
  CancelOfferResponse,
} from '../types/rpc/CancelOffer';
import {
  CheckOfferValidityRequest,
  CheckOfferValidityResponse,
} from '../types/rpc/CheckOfferValidity';
import {
  CreateNewCatWalletRequest,
  CreateNewCatWalletResponse,
} from '../types/rpc/CreateNewCatWallet';
import {
  CreateNewDidWalletRequest,
  CreateNewDidWalletResponse,
} from '../types/rpc/CreateNewDidWallet';
import {
  CreateOfferForIdsRequest,
  CreateOfferForIdsResponse,
} from '../types/rpc/CreateOfferForIds';
import {
  GetAllOffersRequest,
  GetAllOffersResponse,
} from '../types/rpc/GetAllOffers';
import {
  GetCatAssetIdRequest,
  GetCatAssetIdResponse,
} from '../types/rpc/GetCatAssetId';
import {
  GetCatWalletInfoRequest,
  GetCatWalletInfoResponse,
} from '../types/rpc/GetCatWalletInfo';
import {
  GetCurrentAddressRequest,
  GetCurrentAddressResponse,
} from '../types/rpc/GetCurrentAddress';
import {
  GetNextAddressRequest,
  GetNextAddressResponse,
} from '../types/rpc/GetNextAddress';
import { GetNftInfoRequest, GetNftInfoResponse } from '../types/rpc/GetNftInfo';
import {
  GetNftWalletsWithDidsRequest,
  GetNftWalletsWithDidsResponse,
} from '../types/rpc/GetNftWalletsWithDids';
import { GetNftsRequest, GetNftsResponse } from '../types/rpc/GetNfts';
import {
  GetNftsCountRequest,
  GetNftsCountResponse,
} from '../types/rpc/GetNftsCount';
import {
  GetOfferDataRequest,
  GetOfferDataResponse,
} from '../types/rpc/GetOfferData';
import {
  GetOfferRecordRequest,
  GetOfferRecordResponse,
} from '../types/rpc/GetOfferRecord';
import {
  GetOfferSummaryRequest,
  GetOfferSummaryResponse,
} from '../types/rpc/GetOfferSummary';
import {
  GetOffersCountRequest,
  GetOffersCountResponse,
} from '../types/rpc/GetOffersCount';
import {
  GetSyncStatusRequest,
  GetSyncStatusResponse,
} from '../types/rpc/GetSyncStatus';
import {
  GetTransactionRequest,
  GetTransactionResponse,
} from '../types/rpc/GetTransaction';
import {
  GetWalletAddressesRequest,
  GetWalletAddressesResponse,
} from '../types/rpc/GetWalletAddresses';
import {
  GetWalletBalanceRequest,
  GetWalletBalanceResponse,
} from '../types/rpc/GetWalletBalance';
import { GetWalletsRequest, GetWalletsResponse } from '../types/rpc/GetWallets';
import { LogInRequest, LogInResponse } from '../types/rpc/LogIn';
import { MintNftRequest, MintNftResponse } from '../types/rpc/MintNft';
import {
  SendTransactionRequest,
  SendTransactionResponse,
} from '../types/rpc/SendTransaction';
import { SetDidNameRequest, SetDidNameResponse } from '../types/rpc/SetDidName';
import { SetNftDidRequest, SetNftDidResponse } from '../types/rpc/SetNftDid';
import {
  SignMessageByAddressRequest,
  SignMessageByAddressResponse,
} from '../types/rpc/SignMessageByAddress';
import {
  SignMessageByIdRequest,
  SignMessageByIdResponse,
} from '../types/rpc/SignMessageById';
import { SpendCatRequest, SpendCatResponse } from '../types/rpc/SpendCat';
import { TakeOfferRequest, TakeOfferResponse } from '../types/rpc/TakeOffer';
import {
  TransferNftRequest,
  TransferNftResponse,
} from '../types/rpc/TransferNft';
import {
  VerifySignatureRequest,
  VerifySignatureResponse,
} from '../types/rpc/VerifySignature';

import { walletConnectState } from './useWalletConnect';

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
}

let walletBalanceLogCount = 0;
const maxWalletBalanceLogCount = 1;

let addressLogCount = 0;
const maxAddressBalanceLogCount = 1;

async function request<T>(method: ChiaMethod, data: any): Promise<T> {
  if (!walletConnectState.getClient())
    throw new Error('WalletConnect is not initialized');
  if (!walletConnectState.getSession())
    throw new Error('Session is not connected');

  // DEBUG START
  if (method === 'chia_getWalletBalance') {
    walletBalanceLogCount += 1;
  } else if (method === 'chia_getCurrentAddress') {
    addressLogCount += 1;
  }

  if (
    (! ['chia_getWalletBalance', 'chia_getCurrentAddress'].includes(method)) ||
    (method === 'chia_getWalletBalance' && walletBalanceLogCount < maxWalletBalanceLogCount) ||
    (method === 'chia_getCurrentAddress' && addressLogCount < maxAddressBalanceLogCount)
  ) {
    console.warn(
      'walletconnect send request:',
      method,
      data,
      walletConnectState.getSession()!.topic,
      walletConnectState.getChainId(),
    );
    }
  // DEBUG END

  const address = walletConnectState.getAddress();
  if (!address) {
    throw new Error('no fingerprint set in walletconnect');
  }

  const params = { ...data };
  params.fingerprint = parseInt(address);

  const result = await walletConnectState.getClient()!.request({
    topic: walletConnectState.getSession()!.topic,
    chainId: walletConnectState.getChainId(),
    request: { method, params },
  });

  if ('error' in result) throw new Error(JSON.stringify(result.error));

  return result.data;
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
};
