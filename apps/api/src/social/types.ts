import type { PoolClient } from 'pg';
import type { VerifiedSession } from '../oauth/accounts.js';

export interface SocialActor extends VerifiedSession { participantId: string; clientId: string; scopes: string[] }
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';
export interface Source { type: 'USER' | 'CIRCLE' | 'EVENT'; id: string; operation: 'INCLUDE' | 'EXCLUDE' }
export interface CircleView {
  id: string; revision: string; createdAt: string; role: Role; state: 'INVITED' | 'ACTIVE' | 'LEFT' | 'REMOVED';
  members?: { participantId: string; role: Role; state: string }[];
}
export interface Preview {
  sources: Source[];
  eligible: { participantId: string; provenance: Source[] }[];
  excluded: string[];
}
export interface PendingConversationView {
  id: string; revision: string; generation: string; createdAt: string; role: Role;
  memberState: 'PENDING'; orphaned: boolean; sendGate: 'CLOSED';
  sources?: Source[];
  members?: { participantId: string; role: Role; state: 'PENDING'; intervalId: string; provenance: Source[] }[];
}
export interface LeftConversationView {
  id: string; revision: string; createdAt: string; memberState: 'LEFT'; sendGate: 'CLOSED';
  generation?: never; role?: never; orphaned?: never; sources?: never; members?: never;
}
export type ConversationView = PendingConversationView | LeftConversationView;
// Server-owned adapter only; never accept client-submitted event rosters.
// #12 must join this transaction's policy lock before changing its source data.
export interface EventSourceAdapter {
  resolve(db: PoolClient, eventId: string): Promise<{ version: string; participants: string[]; rosterViewers: string[] } | undefined>;
}
export const unavailableEventSources: EventSourceAdapter = { resolve: async () => undefined };
export type AssertOAuthTransaction = (db: PoolClient, actor: SocialActor) => Promise<void>;
export class SocialError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409, public readonly code: string) { super(code); }
}
