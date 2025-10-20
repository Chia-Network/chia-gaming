export type WalletConnectPreferences = {
  enabled?: boolean;
  allowConfirmationFingerprintChange?: boolean;
};

export default function useWalletConnectPreferences(): {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  allowConfirmationFingerprintChange: boolean;
  setAllowConfirmationFingerprintChange: (enabled: boolean) => void;
} {
  const preferences: any = {};
  function setPreferences(p: (a: WalletConnectPreferences) => WalletConnectPreferences) {
    return Object.assign(preferences, p(preferences));
  };

  const enabled = preferences?.enabled ?? false;
  const allowConfirmationFingerprintChange = preferences?.allowConfirmationFingerprintChange ?? false;

  const setEnabled = (value: boolean) => {
    setPreferences((currentPreferences: WalletConnectPreferences) => ({
      ...currentPreferences,
      enabled: value,
    }));
  };

  const setAllowConfirmationFingerprintChange = (value: boolean) => {
    setPreferences((currentPreferences: WalletConnectPreferences) => ({
      ...currentPreferences,
      allowConfirmationFingerprintChange: value,
    }));
  };

  return {
    enabled,
    setEnabled,
    allowConfirmationFingerprintChange,
    setAllowConfirmationFingerprintChange,
  };
}
