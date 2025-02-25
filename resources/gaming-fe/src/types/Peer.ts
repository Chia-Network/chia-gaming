export enum InclusionStatus {
    Success = 1,
    Pending = 2,
    Failed = 3,
}

export type Peer = [
    peerId: string,
    inclusionStatus: InclusionStatus,
    errorMessage: string | null
];
