export interface Session {
  topic: string;
}

export interface Pair {
  topic: string;
  fingerprints: number[];
  mainnet: boolean;
  bypassCommands?: any;
  sessions: Session[];
}
