import type { Circle, Conversation } from '../social/types';
export type MetadataResource = { type: 'circle'; id: string; revision: string; data: Circle } | { type: 'conversation'; id: string; revision: string; data: Conversation };
export type SyncResource = MetadataResource | { type: 'message'; id: string; revision: string; data: null };
export interface SyncPage { mode: 'snapshot' | 'delta'; resources: SyncResource[]; cursor: string; hasMore: boolean }
export interface SyncView { epoch: number; phase: 'syncing' | 'live' | 'retrying' | 'paused' | 'error'; circles: Circle[]; conversations: Conversation[]; errorCode?: string }
export class SyncProtocolError extends Error { readonly code = 'sync_invalid_response'; }
