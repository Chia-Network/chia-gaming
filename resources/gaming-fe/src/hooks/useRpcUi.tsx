import {
    Button,
    Checkbox,
    FormControlLabel,
    FormGroup,
    TextField,
} from '@mui/material';
import { useState } from 'react';
import { useJsonRpc } from './JsonRpcContext';

export function useRpcUi() {
    const rpc = useJsonRpc();

    const [responseData, setResponseData] = useState<any>(null);

    const [fingerprint, setFingerprint] = useState(0);
    const [fingerprints, setFingerprints] = useState<string>('');
    const [amount, setAmount] = useState(0);
    const [count, setCount] = useState(1);
    const [fee, setFee] = useState(0);
    const [number, setNumber] = useState(50);
    const [index, setIndex] = useState(0);
    const [startIndex, setStartIndex] = useState(0);
    const [endIndex, setEndIndex] = useState(50);
    const [backupDidsNeeded, setBackupDidsNeeded] = useState(0);

    const [name, setName] = useState('');
    const [message, setMessage] = useState('');
    const [did, setDid] = useState('');
    const [publicKey, setPublicKey] = useState('');
    const [signature, setSignature] = useState('');
    const [signingMode, setSigningMode] = useState('');
    const [address, setAddress] = useState('');
    const [sortKey, setSortKey] = useState('');
    const [offerData, setOfferData] = useState('');

    const [offer, setOffer] = useState('');
    const [driverDict, setDriverDict] = useState('');

    const [royaltyAddress, setRoyaltyAddress] = useState('');
    const [royaltyPercentage, setRoyaltyPercentage] = useState(0);
    const [targetAddress, setTargetAddress] = useState('');
    const [uris, setUris] = useState('');
    const [hash, setHash] = useState('');
    const [metaUris, setMetaUris] = useState('');
    const [metaHash, setMetaHash] = useState('');
    const [licenseUris, setLicenseUris] = useState('');
    const [licenseHash, setLicenseHash] = useState('');
    const [editionNumber, setEditionNumber] = useState(0);
    const [editionCount, setEditionCount] = useState(0);
    const [didId, setDidId] = useState('');

    const [walletId, setWalletId] = useState(0);
    const [transactionId, setTransactionId] = useState('');
    const [coinId, setCoinId] = useState('');
    const [launcherId, setLauncherId] = useState('');
    const [tradeId, setTradeId] = useState('');
    const [offerId, setOfferId] = useState('');
    const [assetId, setAssetId] = useState('');
    const [nftCoinIds, setNftCoinIds] = useState('');
    const [walletIds, setWalletIds] = useState('');
    const [backupDids, setBackupDids] = useState('');
    const [memos, setMemos] = useState('');

    const [includeData, setIncludeData] = useState(false);
    const [newAddress, setNewAddress] = useState(false);
    const [waitForConfirmation, setWaitForConfirmation] = useState(false);
    const [includeMyOffers, setIncludeMyOffers] = useState(false);
    const [includeTakenOffers, setIncludeTakenOffers] = useState(false);
    const [reverse, setReverse] = useState(false);
    const [disableJsonFormatting, setDisableJsonFormatting] = useState(false);
    const [validateOnly, setValidateOnly] = useState(false);
    const [secure, setSecure] = useState(false);
    const [nonObserverDerivation, setNonObserverDerivation] = useState(false);

    function handlePromise(promise: Promise<any>) {
        promise
            .then((data) => {
                console.log(data);
                setResponseData(data);
            })
            .catch((error) => {
                console.error(error);
                setResponseData({ error: error.message });
            });
    }

    function submitButton(name: string, request: () => Promise<any>) {
        return (
            <Button
                fullWidth
                variant='contained'
                onClick={() => handlePromise(request())}
            >
                {name}
            </Button>
        );
    }

    const commands = {
        // Wallet
        chia_logIn: [
            numberOption('Fingerprint', fingerprint, setFingerprint),
            submitButton('Log In', () => rpc.logIn({ fingerprint })),
        ],
        chia_getWallets: [
            booleanOption('Include Data', includeData, setIncludeData),
            submitButton('Get Wallets', () => rpc.getWallets({ includeData })),
        ],
        chia_getTransaction: [
            stringOption('Transaction Id', transactionId, setTransactionId),
            submitButton('Get Transaction', () =>
                rpc.getTransaction({ transactionId })
            ),
        ],
        chia_getWalletBalance: [
            numberOption('Wallet Id', walletId, setWalletId),
            submitButton('Get Wallet Balance', () =>
                rpc.getWalletBalance({ walletId })
            ),
        ],
        chia_getCurrentAddress: [
            numberOption('Wallet Id', walletId, setWalletId),
            submitButton('Get Current Address', () =>
                rpc.getCurrentAddress({ walletId })
            ),
        ],
        chia_sendTransaction: [
            numberOption('Wallet Id', walletId, setWalletId),
            numberOption('Amount', amount, setAmount),
            numberOption('Fee', fee, setFee),
            stringOption('Address', address, setAddress),
            stringOption('Memos', memos, setMemos),
            booleanOption(
                'Wait For Confirmation',
                waitForConfirmation,
                setWaitForConfirmation
            ),
            submitButton('Send Transaction', () =>
                rpc.sendTransaction({
                    walletId,
                    amount,
                    fee,
                    address,
                    memos: memos.trim().length
                        ? memos.split(',').map((memo) => memo.trim())
                        : [],
                    waitForConfirmation,
                })
            ),
        ],
        chia_signMessageById: [
            stringOption('Message', message, setMessage),
            stringOption('DID', did, setDid),
            submitButton('Sign Message By Id', () =>
                rpc.signMessageById({ message, id: did })
            ),
        ],
        chia_signMessageByAddress: [
            stringOption('Message', message, setMessage),
            stringOption('Address', address, setAddress),
            submitButton('Sign Message By Address', () =>
                rpc.signMessageByAddress({ message, address: address })
            ),
        ],
        chia_verifySignature: [
            stringOption('Message', message, setMessage),
            stringOption('Public Key', publicKey, setPublicKey),
            stringOption('Signature', signature, setSignature),
            stringOption('Address', address, setAddress),
            stringOption('Signing Mode', signingMode, setSigningMode),
            submitButton('Verify Signature', () =>
                rpc.verifySignature({
                    message,
                    pubkey: publicKey,
                    signature,
                    address: address || undefined,
                    signingMode: signingMode || undefined,
                })
            ),
        ],
        chia_getNextAddress: [
            numberOption('Wallet Id', walletId, setWalletId),
            booleanOption('New Address', newAddress, setNewAddress),
            submitButton('Get Next Address', () =>
                rpc.getNextAddress({
                    walletId: walletId || undefined,
                    newAddress,
                })
            ),
        ],
        chia_getSyncStatus: [
            submitButton('Get Sync Status', () => rpc.getSyncStatus({})),
        ],
        chia_getWalletAddresses: [
            stringOption('Fingerprints', fingerprints, setFingerprints),
            numberOption('Index', index, setIndex),
            numberOption('Count', count, setCount),
            booleanOption('Non-Observer Derivation', nonObserverDerivation, setNonObserverDerivation),
            submitButton('Get Wallet Addresses', () =>
                rpc.getWalletAddresses({
                    fingerprints: fingerprints.trim().length ? fingerprints.split(',').map((fingerprint) => +fingerprint.trim()) : undefined,
                    index,
                    count,
                    nonObserverDerivation,
                })
            ),
        ],

        // Offers
        chia_getAllOffers: [
            numberOption('Start Index', startIndex, setStartIndex),
            numberOption('End Index', endIndex, setEndIndex),
            stringOption('Sort Key', sortKey, setSortKey),
            booleanOption(
                'Include My Offers',
                includeMyOffers,
                setIncludeMyOffers
            ),
            booleanOption(
                'Include Taken Offers',
                includeTakenOffers,
                setIncludeTakenOffers
            ),
            booleanOption('Reverse', reverse, setReverse),
            submitButton('Get All Offers', () =>
                rpc.getAllOffers({
                    start: startIndex || undefined,
                    end: endIndex || undefined,
                    includeMyOffers,
                    includeTakenOffers,
                    reverse,
                    sortKey: sortKey || undefined,
                })
            ),
        ],
        chia_getOffersCount: [
            submitButton('Get Offers Count', () => rpc.getOffersCount({})),
        ],
        chia_createOfferForIds: [
            stringOption('Offer', offer, setOffer),
            stringOption('Driver Dict', driverDict, setDriverDict),
            booleanOption(
                'Disable JSON Formatting',
                disableJsonFormatting,
                setDisableJsonFormatting
            ),
            booleanOption('Validate Only', validateOnly, setValidateOnly),
            submitButton('Create Offer For Ids', () =>
                rpc.createOfferForIds({
                    disableJSONFormatting: disableJsonFormatting,
                    validateOnly,
                    offer: JSON.parse(offer || '{}'),
                    driverDict: JSON.parse(driverDict || '{}'),
                })
            ),
        ],
        chia_cancelOffer: [
            numberOption('Fee', fee, setFee),
            stringOption('Trade Id', tradeId, setTradeId),
            booleanOption('Secure', secure, setSecure),
            submitButton('Cancel Offer', () =>
                rpc.cancelOffer({
                    fee,
                    secure,
                    tradeId,
                })
            ),
        ],
        chia_checkOfferValidity: [
            stringOption('Offer Data', offerData, setOfferData),
            submitButton('Check Offer Validity', () =>
                rpc.checkOfferValidity({ offerData })
            ),
        ],
        chia_takeOffer: [
            numberOption('Fee', fee, setFee),
            stringOption('Offer Data', offerData, setOfferData),
            submitButton('Take Offer', () =>
                rpc.takeOffer({ fee, offer: offerData })
            ),
        ],
        chia_getOfferSummary: [
            stringOption('Offer Data', offerData, setOfferData),
            submitButton('Get Offer Summary', () =>
                rpc.getOfferSummary({ offerData })
            ),
        ],
        chia_getOfferData: [
            stringOption('Offer Id', offerId, setOfferId),
            submitButton('Get Offer Data', () => rpc.getOfferData({ offerId })),
        ],
        chia_getOfferRecord: [
            stringOption('Offer Id', offerId, setOfferId),
            submitButton('Get Offer Record', () =>
                rpc.getOfferRecord({ offerId })
            ),
        ],

        // CATs
        chia_createNewCATWallet: [
            numberOption('Amount', amount, setAmount),
            numberOption('Fee', fee, setFee),
            submitButton('Create New CAT Wallet', () =>
                rpc.createNewCatWallet({ amount, fee })
            ),
        ],
        chia_getCATWalletInfo: [
            stringOption('Asset Id', assetId, setAssetId),
            submitButton('Get CAT Wallet Info', () =>
                rpc.getCatWalletInfo({ assetId })
            ),
        ],
        chia_getCATAssetId: [
            numberOption('Wallet Id', walletId, setWalletId),
            submitButton('Get CAT Asset Id', () =>
                rpc.getCatAssetId({ walletId })
            ),
        ],
        chia_spendCAT: [
            numberOption('Wallet Id', walletId, setWalletId),
            stringOption('Address', address, setAddress),
            numberOption('Amount', amount, setAmount),
            numberOption('Fee', fee, setFee),
            booleanOption(
                'Wait For Confirmation',
                waitForConfirmation,
                setWaitForConfirmation
            ),
            submitButton('Spend CAT', () =>
                rpc.spendCat({
                    walletId,
                    address,
                    amount,
                    fee,
                    memos: memos.trim().length
                        ? memos.split(',').map((memo) => memo.trim())
                        : undefined,
                    waitForConfirmation,
                })
            ),
        ],
        chia_addCATToken: [
            stringOption('Name', name, setName),
            stringOption('Asset Id', assetId, setAssetId),
            submitButton('Add CAT Token', () =>
                rpc.addCatToken({ name, assetId })
            ),
        ],

        // NFTs
        chia_getNFTs: [
            numberOption('Wallet Id', walletId, setWalletId),
            numberOption('Number', number, setNumber),
            numberOption('Start Index', startIndex, setStartIndex),
            submitButton('Get NFTs', () =>
                rpc.getNfts({ walletIds: [walletId], num: number, startIndex })
            ),
        ],
        chia_getNFTInfo: [
            stringOption('Coin Id', coinId, setCoinId),
            submitButton('Get NFT Info', () => rpc.getNftInfo({ coinId })),
        ],
        chia_mintNFT: [
            numberOption('Wallet Id', walletId, setWalletId),
            stringOption('Royalty Address', royaltyAddress, setRoyaltyAddress),
            numberOption(
                'Royalty Percentage',
                royaltyPercentage,
                setRoyaltyPercentage
            ),
            stringOption('Target Address', targetAddress, setTargetAddress),
            stringOption('URIs', uris, setUris),
            stringOption('Hash', hash, setHash),
            stringOption('Meta URIs', metaUris, setMetaUris),
            stringOption('Meta Hash', metaHash, setMetaHash),
            stringOption('License URIs', licenseUris, setLicenseUris),
            stringOption('License Hash', licenseHash, setLicenseHash),
            numberOption('Edition Number', editionNumber, setEditionNumber),
            numberOption('Edition Count', editionCount, setEditionCount),
            stringOption('DID ID', didId, setDidId),
            numberOption('Fee', fee, setFee),
            submitButton('Mint NFT', () =>
                rpc.mintNft({
                    walletId,
                    royaltyAddress,
                    royaltyPercentage,
                    targetAddress,
                    uris: uris.trim().length
                        ? uris.split(',').map((id) => id.trim())
                        : [],
                    hash,
                    metaUris: metaUris.trim().length
                        ? metaUris.split(',').map((id) => id.trim())
                        : [],
                    metaHash,
                    licenseUris: licenseUris.trim().length
                        ? licenseUris.split(',').map((id) => id.trim())
                        : [],
                    licenseHash,
                    editionNumber,
                    editionCount,
                    didId,
                    fee,
                })
            ),
        ],
        chia_transferNFT: [
            numberOption('Wallet Id', walletId, setWalletId),
            stringOption('NFT Coin Ids', nftCoinIds, setNftCoinIds),
            stringOption('Address', address, setAddress),
            numberOption('Fee', fee, setFee),
            submitButton('Transfer NFT', () =>
                rpc.transferNft({
                    walletId,
                    nftCoinIds: nftCoinIds.trim().length
                        ? nftCoinIds.split(',').map((id) => id.trim())
                        : [],
                    targetAddress: address,
                    fee,
                })
            ),
        ],
        chia_getNFTsCount: [
            stringOption('Wallet Ids', walletIds, setWalletIds),
            submitButton('Get NFTs Count', () =>
                rpc.getNftsCount({
                    walletIds: walletIds.trim().length
                        ? walletIds.split(',').map((id) => +id.trim())
                        : [],
                })
            ),
        ],

        // DIDs
        chia_createNewDIDWallet: [
            numberOption('Amount', amount, setAmount),
            numberOption('Fee', fee, setFee),
            numberOption(
                'Number of Backup Dids Needed',
                backupDidsNeeded,
                setBackupDidsNeeded
            ),
            stringOption('Backup Dids', backupDids, setBackupDids),
            submitButton('Create New DID Wallet', () =>
                rpc.createNewDidWallet({
                    amount,
                    fee,
                    backupDids: backupDids.trim().length
                        ? backupDids.split(',').map((id) => id.trim())
                        : [],
                    numOfBackupIdsNeeded: backupDidsNeeded,
                })
            ),
        ],
        chia_setDIDName: [
            numberOption('Wallet Id', walletId, setWalletId),
            stringOption('Name', name, setName),
            submitButton('Set DID Name', () =>
                rpc.setDidName({ name, walletId })
            ),
        ],
        chia_setNFTDID: [
            numberOption('Wallet Id', walletId, setWalletId),
            stringOption('NFT Coin Ids', nftCoinIds, setNftCoinIds),
            stringOption('Launcher Id', launcherId, setLauncherId),
            stringOption('DID', did, setDid),
            numberOption('Fee', fee, setFee),
            submitButton('Set NFT DID', () =>
                rpc.setNftDid({
                    walletId,
                    nftCoinIds: nftCoinIds.trim().length
                        ? nftCoinIds.split(',').map((id) => id.trim())
                        : [],
                    nftLauncherId: launcherId,
                    did,
                    fee,
                })
            ),
        ],
        chia_getNFTWalletsWithDIDs: [
            submitButton('Get NFT Wallets With DIDs', () =>
                rpc.getNftWalletsWithDids({})
            ),
        ],
    };

    return { commands, responseData };
}

function stringOption(
    name: string,
    value: string,
    setValue: React.Dispatch<React.SetStateAction<string>>
) {
    return (
        <TextField
            fullWidth
            label={name}
            variant='outlined'
            value={value}
            onChange={(e) => setValue(e.target.value)}
        />
    );
}

function numberOption(
    name: string,
    value: number,
    setValue: React.Dispatch<React.SetStateAction<number>>
) {
    return (
        <TextField
            fullWidth
            type='number'
            label={name}
            variant='outlined'
            value={isNaN(value) ? '' : value}
            onChange={(e) => {
                setValue(e.target.value ? +e.target.value : NaN);
            }}
        />
    );
}

function booleanOption(
    name: string,
    value: boolean,
    setValue: React.Dispatch<React.SetStateAction<boolean>>
) {
    return (
        <FormGroup>
            <FormControlLabel
                control={
                    <Checkbox
                        checked={value}
                        onChange={(e) => setValue(e.target.checked)}
                    />
                }
                label={name}
            />
        </FormGroup>
    );
}
