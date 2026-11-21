import type { CloudWalletTokenResponse } from '../shared/ipc';

type TokenFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'text'>>;

export async function relayCloudWalletToken(
  tokenUrl: string,
  body: string,
  fetchToken: TokenFetch,
): Promise<CloudWalletTokenResponse> {
  try {
    const response = await fetchToken(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { transportError: (error as Error).message };
  }
}
