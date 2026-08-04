const PREFIX = '[chia-gaming-desktop]';

export const log = {
  info(message: string): void {
    console.log(`${PREFIX} ${message}`);
  },
  warn(message: string): void {
    console.warn(`${PREFIX} ${message}`);
  },
  error(message: string): void {
    console.error(`${PREFIX} ${message}`);
  },
};
