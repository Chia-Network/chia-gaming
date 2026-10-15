// Minimal declarations for the CommonJS Holepunch modules main uses. Neither
// ships its own types in the pinned versions. Both are streamx streams, not
// Node streams, so only the members main touches are declared.

declare module 'pear-runtime' {
  interface Sidecar {
    readonly stderr: { on(event: 'data', listener: (data: Buffer) => void): void };
    on(event: 'exit', listener: (code: number | null) => void): this;
  }

  const PearRuntime: {
    /** Spawn a Bare worker; returns its IPC pipe. */
    run(entrypoint: string, args?: string[]): Sidecar;
  };
  export default PearRuntime;
}

declare module 'framed-stream' {
  class FramedStream {
    constructor(rawStream: unknown);
    write(data: Buffer): boolean;
    destroy(): void;
    on(event: 'data', listener: (data: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
  export default FramedStream;
}
