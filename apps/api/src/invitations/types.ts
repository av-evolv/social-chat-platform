import type { Locale } from '@larynx/i18n';
import type { SocialActor } from '../social/types.js';
export type InvitationActor = SocialActor;
export interface Target { type: 'CIRCLE' | 'CONVERSATION'; id: string }
export interface InvitationView {
  id: string; revision: string; target: Target; recipientEmail: string; createdAt: string; expiresAt: string;
  state: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'; delivery: 'PENDING' | 'SENT' | 'FAILED';
}
// Raw credentials exist only while sending committed intent, never in persisted payloads.
export interface Delivery { locale?: Locale; email: string; token: string; kind: 'invitation' | 'verification'; invitationId: string; revision: string }
export interface IssuedInvitation { invitation: InvitationView; delivery?: Delivery }
export class InvitationError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 429, public readonly code: string) { super(code); }
}
