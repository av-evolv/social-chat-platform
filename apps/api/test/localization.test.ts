import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '@larynx/i18n';
import { escapeHtml, languageLinks, requestedLocale } from '../src/identity/locale.js';
import { verificationMessage } from '../src/identity/mail.js';
import { invitationMessage } from '../src/invitations/mail.js';

test('Issuer language negotiation accepts OIDC preferences without accepting unsafe markup', () => {
  assert.equal(requestedLocale('de fr-CA en','en'),'fr');
  assert.equal(requestedLocale(undefined,'de,fr;q=0.7,en;q=0.3'),'fr');
  assert.equal(requestedLocale('<script>','unsupported'),'en');
  const links = languageLinks('fr','/account/login',{return_to:'/oidc/interaction/known',ui_locales:'fr'});
  assert.match(links,/return_to=%2Foidc%2Finteraction%2Fknown/);
  assert.match(links,/lang=fr/);
  assert.equal(escapeHtml(translate('fr','server.oauth.application',{name:'<img src=x onerror="alert(1)">'})), 'Application : &lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('English and French transactional messages retain exact credentials and safety instructions', async () => {
  const token = '-'+ 'a'.repeat(41)+'_';
  const deliveries = await Promise.all(Array.from({length:20},async (_,index) => {
    const locale = index%2 ? 'fr' : 'en';
    const verify = verificationMessage(locale,token,'register');
    const recover = verificationMessage(locale,token,'recover');
    const invitation = invitationMessage({locale,email:'reader@example.com',token,kind:'invitation',invitationId:'id',revision:'1'},'https://app.example');
    const proof = invitationMessage({locale,email:'reader@example.com',token,kind:'verification',invitationId:'id',revision:'1'},'https://app.example');
    for (const message of [verify,recover,invitation,proof]) {
      assert.ok(message.text.includes(`\n\n${token}\n\n`));
      assert.ok(!message.text.includes('server.'));
    }
    assert.equal(verify.subject,translate(locale,'server.mail.registerSubject'));
    assert.ok(invitation.text.includes(`https://app.example/invitations?lang=${locale}`));
    assert.ok(recover.text.includes(translate(locale,'server.mail.recoveryWarning')));
    return verify.subject;
  }));
  assert.equal(new Set(deliveries).size,2);
});
