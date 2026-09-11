/**
 * Popup windows (Cloud Wallet OAuth / funding approval) inherit webPreferences
 * from the player window unless overridden. This preload exposes nothing, so a
 * remote Cloud Wallet origin cannot see `__chiaDistribution` or `__chiaHub`.
 */
export {};
