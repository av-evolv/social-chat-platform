import type { PoolClient } from 'pg';
import type { SocialActor } from '../social/types.js';

export interface MessageMetadata {
  id: string; conversationId: string; authorId: string; authorDeviceId: string;
  revision: string; createdAt: string; updatedAt: string; deleted: boolean;
  generation: string; cryptoEpoch: string; envelopeVersion: 1; senderDeviceId: string;
}
export interface MessageView extends MessageMetadata { ciphertext: string }
export interface MessageReceipt { id: string; conversationId: string; revision: string; deleted: boolean }
export interface MessageEnvelopeInput { envelopeVersion: 1; generation: string; cryptoEpoch: string; ciphertext: string }
export interface MessageCreateInput extends MessageEnvelopeInput { id: string }
export interface MessageUpdateInput extends MessageEnvelopeInput { expectedRevision: string }
export interface MessageDeleteInput { expectedRevision: string; generation: string; cryptoEpoch: string }
/** Server-owned #10 boundary, executed under the same policy transaction as the
 * effect/read. It must check current device, membership, epoch and history access;
 * recipients must be canonical principals derived from server policy. */
export type MessageAdmission = (db: PoolClient, actor: SocialActor, request: {
  action: 'create' | 'read' | 'update' | 'delete'; conversationId: string;
  message?: MessageMetadata; generation?: string; cryptoEpoch?: string;
}) => Promise<{ generation: string; cryptoEpoch: string; recipients: string[] }>;
export class MessageError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 413, public readonly code: string) { super(code); }
}
