export interface TradeSummary {
    fees: number;
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
    offered: Record<string, number>;
    requested: Record<string, number>;
}
