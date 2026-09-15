import nodemailer from 'nodemailer';
import type { IdentityConfig } from '../identity/config.js';
import type { Delivery } from './types.js';
export type InvitationMailer = (delivery: Delivery) => Promise<void>;
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
    const invitation = delivery.kind === 'invitation';
    await transport.sendMail({from:config.smtp.from,to:{address:delivery.email,name:''},
      subject:invitation ? 'You have a Larynx invitation' : 'Verify your Larynx invitation',
      text:invitation
        ? `Someone invited you to Larynx. Open ${url.href}, sign in or create an account, then paste this invitation code:\n\n${delivery.token}\n\nThe invitation expires after seven days. A resent invitation replaces the previous code. Opening this email grants no access. Request a fresh verification code before accepting. If this is unexpected, ignore it.`
        : `Your Larynx invitation verification code:\n\n${delivery.token}\n\nPaste this code into the signed-in app where you requested it within ten minutes. Sign in with the account already registered to this email. Accepting joins only the selected invitation and does not add a recovery email. Never share the code. If you did not request this, ignore it.`,
    });
  };
}
