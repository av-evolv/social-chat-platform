// Public relationship metadata. Private conversation content is not exposed here.
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';
export interface Source { type: 'USER' | 'CIRCLE' | 'EVENT'; id: string; operation: 'INCLUDE' | 'EXCLUDE' }
export interface Circle {
  id: string; revision: string; createdAt: string; role: Role; state: 'INVITED' | 'ACTIVE' | 'LEFT' | 'REMOVED';
  members?: { participantId: string; role: Role; state: string }[];
}
export interface Preview { sources: Source[]; eligible: { participantId: string; provenance: Source[] }[]; excluded: string[] }
export interface PendingConversation {
  id: string; revision: string; generation: string; createdAt: string; role: Role; memberState: 'PENDING'; orphaned: boolean; sendGate: 'CLOSED';
  sources?: Source[];
  members?: { participantId: string; role: Role; state: 'PENDING'; intervalId: string; provenance: Source[] }[];
}

export interface LeftConversation {
  id: string; revision: string; createdAt: string; memberState: 'LEFT'; sendGate: 'CLOSED';
}
export type Conversation = PendingConversation | LeftConversation;
