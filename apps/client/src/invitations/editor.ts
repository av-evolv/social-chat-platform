import type { Circle, Conversation } from '../social/types';
export interface InvitationTarget { type: 'CIRCLE' | 'CONVERSATION'; id: string }
export interface Invitation {
  id: string; revision: string; target: InvitationTarget; recipientEmail: string; createdAt: string; expiresAt: string;
  state: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'; delivery: 'PENDING' | 'SENT' | 'FAILED';
}

// The server rechecks authority and revisions on every action. These filters avoid
// offering an invitation destination that is already known to be unavailable.
export function invitationTargets(circles: Circle[], conversations: Conversation[]): (InvitationTarget & { revision: string })[] {
  return [
    ...circles.filter(value => value.state === 'ACTIVE' && ['OWNER', 'ADMIN'].includes(value.role)).map(value => ({ type: 'CIRCLE' as const, id: value.id, revision: value.revision })),
    ...conversations.flatMap(value => value.memberState === 'PENDING' && !value.orphaned && ['OWNER', 'ADMIN'].includes(value.role) ? [{ type: 'CONVERSATION' as const, id: value.id, revision: value.revision }] : []),
  ];
}
