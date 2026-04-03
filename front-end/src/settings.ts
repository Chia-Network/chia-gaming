const _host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
export const BLOCKCHAIN_SERVICE_URL =
  (window as any).__SIM_URL__ || `http://${_host}:5800`;
export const BLOCKCHAIN_WS_URL =
  (window as any).__SIM_WS_URL__ || `ws://${_host}:5801`;
export const GAME_SERVICE_URL =
  (window as any).__GAME_URL__ || `http://${_host}:3002`;
// Note: The Lobby URL is obtained from the "start game" URL
