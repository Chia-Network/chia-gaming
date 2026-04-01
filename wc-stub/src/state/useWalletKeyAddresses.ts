export default function useWalletKeyAddresses() {
  const { data: walletAddresses, isLoading: isLoadingWalletAddresses } = {
    data: [],
    isLoading: true,
  };

  const addresses = () => {
    if (!walletAddresses || isLoadingWalletAddresses) {
      return [];
    }

    return Object.keys(walletAddresses).map((fingerprint: string) => {
      let walletAddressSelection: any =
        walletAddresses[parseInt(fingerprint.toString())][0];
      return {
        fingerprint,
        address: walletAddressSelection.address,
      };
    });
  };

  return { addresses, isLoading: isLoadingWalletAddresses };
}
