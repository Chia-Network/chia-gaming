const _raw = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const _host = _raw === 'localhost' ? '127.0.0.1' : _raw;
const _win = typeof window !== 'undefined' ? (window as any) : {};
const _env = typeof process !== 'undefined' ? process.env : {};
export const BLOCKCHAIN_SERVICE_URL =
  _win.__SIM_URL__ || _env.CHIA_GAMING_SIM_URL || `http://${_host}:5800`;
export const BLOCKCHAIN_WS_URL =
  _win.__SIM_WS_URL__ || _env.CHIA_GAMING_SIM_WS_URL || `ws://${_host}:5800/ws`;
// Note: The Hub URL is obtained from the "start game" URL / HubPicker
