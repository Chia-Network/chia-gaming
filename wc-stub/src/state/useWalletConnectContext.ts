export default function useWalletConnectContext() {
  const context = {};
  if (!context) {
    throw new Error(
      'useWalletConnectContext must be used within a WalletConnectProvider',
    );
  }

  return context;
}
