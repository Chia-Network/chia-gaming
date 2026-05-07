export interface TradeSummary {
  fees: bigint;
  infos: Record<
    string,
    {
      also: {
        also: {
          owner: string;
          transferProgram: {
            launcherId: string;
            royaltyAddress: string;
            royaltyPercentage: string;
            type: 'royalty transfer program';
          };
          type: 'ownership';
        };
        metadata: string;
        type: 'metadata';
        updaterHash: string;
      };
      launcherId: string;
      launcherPh: string;
      type: 'singleton';
    }
  >;
  offered: Record<string, bigint>;
  requested: Record<string, bigint>;
}
