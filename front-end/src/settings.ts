const _host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const _win = typeof window !== 'undefined' ? (window as any) : {};
export const BLOCKCHAIN_SERVICE_URL =
  _win.__SIM_URL__ || `http://${_host}:5800`;
export const BLOCKCHAIN_WS_URL =
  _win.__SIM_WS_URL__ || `ws://${_host}:5801`;
export const GAME_SERVICE_URL =
  _win.__GAME_URL__ || `http://${_host}:3002`;
// Note: The Lobby URL is obtained from the "start game" URL
