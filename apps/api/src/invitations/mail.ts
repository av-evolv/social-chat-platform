import { translate } from '@larynx/i18n';
import nodemailer from 'nodemailer';
import type { IdentityConfig } from '../identity/config.js';
import type { Delivery } from './types.js';
export type InvitationMailer = (delivery: Delivery) => Promise<void>;
export function invitationMessage(delivery: Delivery, appUrl: string) {
  const locale = delivery.locale ?? 'en';
  const url = new URL('/invitations',appUrl); url.searchParams.set('lang',locale);
  const t = (key: string, values: Record<string,unknown> = {}) => translate(locale,`server.mail.${key}`,values);
  const invitation = delivery.kind === 'invitation';
  return {subject:t(invitation ? 'invitationSubject' : 'proofSubject'),
    text:`${invitation ? t('invitationIntro',{url:url.href}) : t('proofIntro')}\n\n${delivery.token}\n\n${t(invitation ? 'invitationInstructions' : 'proofInstructions')}`};
}
export function createInvitationMailer(config: IdentityConfig, appUrl: string): InvitationMailer {
  const url = new URL('/invitations', appUrl);
  if (config.mode === 'production' ? url.protocol !== 'https:' : !['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Invalid invitation app URL');
  const transport = nodemailer.createTransport({
    host:config.smtp.host,port:config.smtp.port,secure:config.smtp.secure,requireTLS:config.mode === 'production',
    auth:config.smtp.user ? {user:config.smtp.user,pass:config.smtp.password} : undefined,
    logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,
    connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},
  });
  return async delivery => {
    await transport.sendMail({from:config.smtp.from,to:{address:delivery.email,name:''},...invitationMessage(delivery,appUrl)});
  };
}
