declare const bounds: {
  readonly gameTimeoutBlocks: {
    readonly min: number;
    readonly max: number;
  };
  readonly sessionTimeoutBlocks: {
    readonly min: number;
    readonly max: number;
  };
  /** Display names are trimmed, then limited to this many UTF-8 bytes. */
  readonly aliasBytes: {
    readonly max: number;
  };
};

export = bounds;
