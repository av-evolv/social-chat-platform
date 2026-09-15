import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitationTargets } from '../src/invitations/editor.ts';

test('invitation destinations exclude unaccepted circles, ordinary members, left conversations and orphaned administration', () => {
  const circles = [
    { id: 'circle-owner', revision: '4', state: 'ACTIVE', role: 'OWNER' },
    { id: 'circle-admin', revision: '7', state: 'ACTIVE', role: 'ADMIN' },
    { id: 'circle-member', revision: '2', state: 'ACTIVE', role: 'MEMBER' },
    { id: 'circle-invited', revision: '2', state: 'INVITED', role: 'OWNER' },
    { id: 'circle-removed', revision: '2', state: 'REMOVED', role: 'OWNER' },
  ];
  const conversations = [
    { id: 'chat-owner', revision: '9', memberState: 'PENDING', role: 'OWNER', orphaned: false },
    { id: 'chat-admin', revision: '11', memberState: 'PENDING', role: 'ADMIN', orphaned: false },
    { id: 'chat-member', revision: '1', memberState: 'PENDING', role: 'MEMBER', orphaned: false },
    { id: 'chat-orphan', revision: '1', memberState: 'PENDING', role: 'OWNER', orphaned: true },
    { id: 'chat-left', revision: '1', memberState: 'LEFT' },
  ];
  assert.deepEqual(invitationTargets(circles, conversations), [
    { type: 'CIRCLE', id: 'circle-owner', revision: '4' },
    { type: 'CIRCLE', id: 'circle-admin', revision: '7' },
    { type: 'CONVERSATION', id: 'chat-owner', revision: '9' },
    { type: 'CONVERSATION', id: 'chat-admin', revision: '11' },
  ]);
});
