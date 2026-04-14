export interface GetPuzzleAndSolutionRequest {
  coinName: string;
}

export interface GetPuzzleAndSolutionResponse {
  puzzleReveal: string;
  solution: string;
  success: boolean;
}
