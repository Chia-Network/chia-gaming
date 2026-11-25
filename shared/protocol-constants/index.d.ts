declare const bounds: {
  readonly gameTimeoutBlocks: {
    readonly min: number;
    readonly max: number;
  };
  readonly sessionTimeoutBlocks: {
    readonly min: number;
    readonly max: number;
  };
  readonly fees: {
    readonly minMojosPerCost: number;
    readonly openingCostShare: number;
  };
};

export = bounds;
