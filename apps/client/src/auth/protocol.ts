export interface PendingFlow {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export function callbackCode(url: string, flow: PendingFlow, now = Date.now(), expectedIssuer?: string): string {
  const callback = new URL(url);
  const expected = new URL(flow.redirectUri);
  if (callback.origin !== expected.origin || callback.protocol !== expected.protocol || callback.host !== expected.host || callback.pathname !== expected.pathname || callback.hash) {
    throw new Error('The sign-in callback does not match this app.');
  }
  const params = callback.searchParams;
  if (now < flow.createdAt || now - flow.createdAt > 10 * 60_000 || params.getAll('state').length !== 1 || params.get('state') !== flow.state) {
    throw new Error('This sign-in request has expired or does not match. Please start again.');
  }
  if (expectedIssuer && (params.getAll('iss').length !== 1 || params.get('iss') !== expectedIssuer)) throw new Error('The sign-in response came from an unexpected issuer.');
  if (params.has('error')) throw new Error('Sign-in was not approved. Please try again when ready.');
  const code = params.get('code');
  if (!code || params.getAll('code').length !== 1) throw new Error('The sign-in response is incomplete.');
  return code;
}

export function parsePendingFlow(value: string | null): PendingFlow {
  if (!value) throw new Error('No pending sign-in was found. Please start again.');
  const flow = JSON.parse(value) as Partial<PendingFlow>;
  if (!flow || typeof flow !== 'object' || typeof flow.state !== 'string' || flow.state.length < 20 || typeof flow.nonce !== 'string' || flow.nonce.length < 20 || typeof flow.verifier !== 'string' || flow.verifier.length < 43 || typeof flow.redirectUri !== 'string' || typeof flow.createdAt !== 'number') {
    throw new Error('The pending sign-in is invalid. Please start again.');
  }
  return flow as PendingFlow;
}
