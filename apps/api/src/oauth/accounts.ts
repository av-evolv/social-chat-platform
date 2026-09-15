import type { IncomingMessage } from 'node:http';

export interface VerifiedSession {
  accountId: string;
  deviceId: string;
  sessionId: string;
}

// #5 supplies primary-backed verified account/session/device state. No request
// body, OAuth scope or invitation URL may manufacture a VerifiedSession.
export interface AccountDirectory {
  authenticate(request: IncomingMessage): Promise<VerifiedSession | undefined>;
  findAccount(accountId: string): Promise<{ id: string; participantId: string; locale?: 'en' | 'fr' | null } | undefined>;
  saveLocale?(session: VerifiedSession, locale: 'en' | 'fr'): Promise<void>;
  isSessionActive(session: VerifiedSession): Promise<boolean>;
}

export const unavailableAccounts: AccountDirectory = {
  authenticate: async () => undefined,
  findAccount: async () => undefined,
  isSessionActive: async () => false,
};
