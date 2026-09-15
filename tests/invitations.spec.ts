import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test';
const inbox = `http://127.0.0.1:${process.env.MAILPIT_HTTP_PORT ?? '8025'}`;
const apiOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? `http://localhost:${process.env.API_PORT ?? '3000'}`;
// Keep credentials in memory and out of test request attachments and error output.
function authenticatedApi(page: Page) {
  let authorization: string | undefined;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === apiOrigin && url.pathname.startsWith('/v1/')) {
      authorization = request.headers().authorization ?? authorization;
    }
  });
  return async <T>(path: string, body?: unknown): Promise<T> => {
    if (!authorization) throw new Error('Expected an authenticated application request');
    const url = new URL(path, apiOrigin);
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/v1/')) throw new Error('Unexpected test API target');
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { Authorization: authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(200);
    return await response.json() as T;
  };
}
async function mailCode(request: APIRequestContext, email: string, subject: string) {
  let id: string | undefined;
  await expect.poll(async()=>{
    const list=await(await request.get(`${inbox}/api/v1/messages`)).json();
    id=list.messages.find((m:{ID:string;Subject:string;To:{Address:string}[]})=>m.Subject===subject && m.To.some(to=>to.Address===email))?.ID;
    return Boolean(id);
  }).toBe(true);
  const message=await(await request.get(`${inbox}/api/v1/message/${id}`)).json();
  const code=(message.Text as string).split(/\r?\n/).map(line=>line.trim()).find(line=>/^[A-Za-z0-9_-]{43}$/.test(line)); expect(code).toBeTruthy(); return code as string;
}
async function register(page:Page,context:BrowserContext,request:APIRequestContext,email:string) {
  const cdp=await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto('/account');
  await page.getByRole('button',{name:'Sign in or create account',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(email);
  await page.getByRole('button',{name:'Send verification code',exact:true}).click();
  await page.getByLabel('Code from your email',{exact:true}).fill(await mailCode(request,email,'Verify your Larynx email'));
  await page.getByRole('button',{name:'Verify email and create passkey',exact:true}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Allow',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Signed in',exact:true})).toBeVisible();
}
test('new recipient signs up, proves invited email and accepts only the selected circle',async({page,context,browser,request},testInfo)=>{
  test.setTimeout(120_000);
  const suffix=randomUUID(); const sender=`invite-sender-${suffix}@larynx.test`; const recipient=`invite-recipient-${suffix}@larynx.test`;
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  const senderApi = authenticatedApi(page);
  await register(page,context,request,sender);
  await page.getByRole('link',{name:'Your circles and conversations →',exact:true}).click();
  await page.getByRole('button',{name:'Create circle',exact:true}).click();
  await expect(page.getByText('Circle created. Invite someone using their contact code.',{exact:true})).toBeVisible();
  const circleId=await page.getByRole('heading',{level:3}).textContent();
  await page.getByRole('link',{name:/email invitations/i}).click();
  await page.getByRole('button',{name:/^(?:✓ )?Circle [a-f0-9]{6}$/}).click();
  await page.getByLabel('Recipient email address',{exact:true}).fill(recipient);
  await page.getByRole('button',{name:'Send email invitation',exact:true}).click();
  await expect(page.getByText('pending · Delivery sent',{exact:true})).toBeVisible();
  const token=await mailCode(request,recipient,'You have a Larynx invitation');
  const recipientContext=await browser.newContext({baseURL:testInfo.project.use.baseURL ?? 'http://127.0.0.1:8088',viewport:testInfo.project.use.viewport ?? {width:1280,height:800}});
  try {
    const other=await recipientContext.newPage();other.on('pageerror',e=>errors.push(e.message));
    const recipientApi = authenticatedApi(other);
    await register(other,recipientContext,request,recipient);
    await other.getByRole('link',{name:/email invitations/i}).click();
    await other.getByLabel('Invited email address',{exact:true}).fill(recipient);
    await other.getByLabel('Invitation code',{exact:true}).fill(token);
    await other.getByRole('button',{name:'Request verification code',exact:true}).click();
    await other.getByLabel('Invitation verification code',{exact:true}).fill(await mailCode(request,recipient,'Verify your Larynx invitation'));
    await other.getByRole('checkbox',{name:'Accept this invitation for my signed-in account',exact:true}).click();
    await other.getByRole('button',{name:'Accept invitation',exact:true}).click();
    await expect(other.getByText(/Invitation accepted for Circle/)).toBeVisible();
    await expect(other.getByLabel('Invitation code',{exact:true})).toHaveValue('');
    expect(await other.evaluate(()=>({local:Object.keys(localStorage).filter(key=>key!=='larynx.locale'),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
    expect(new URL(other.url()).search).toBe(''); expect(new URL(other.url()).hash).toBe('');
    await other.getByRole('link',{name:'Your circles and conversations →',exact:true}).click();
    await expect(other.getByRole('button',{name:circleId!,exact:true})).toBeVisible();
    await expect(other.getByText('active · member',{exact:true})).toBeVisible();
    expect(await other.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await other.screenshot({path:testInfo.outputPath('invitation-accepted.png'),fullPage:true});
    await page.getByRole('button',{name:'Refresh invitations',exact:true}).click();
    await expect(page.getByText('accepted · Delivery sent',{exact:true})).toBeVisible();
    await expect(other.getByText('Up to date',{exact:true})).toBeVisible();

    let circles = await senderApi<{id:string;revision:string}[]>('/v1/social/circles');
    expect(circles).toHaveLength(1);
    const recipientSession = await recipientApi<{participantId:string}>('/v1/session');
    await other.getByRole('button',{name:'New conversation',exact:true}).click();
    await other.getByRole('button',{name:'Preview audience',exact:true}).click();
    await expect(other.getByRole('heading',{name:'Audience preview',exact:true})).toBeVisible();
    await expect(other.getByLabel('Audience source code',{exact:true})).toBeVisible();
    // Even a metadata reset with no selected conversation must discard an
    // unsaved audience editor and its previously authorized preview.
    await senderApi(`/v1/social/circles/${circles[0]!.id}/role`, {
      participant_id: recipientSession.participantId,
      role: 'MEMBER',
      expected_revision: circles[0]!.revision,
    });
    await expect(other.getByLabel('Audience source code',{exact:true})).toHaveCount(0,{timeout:35_000});
    await expect(other.getByRole('heading',{name:'Audience preview',exact:true})).toHaveCount(0);
    await expect(other.getByText('Up to date',{exact:true})).toBeVisible();
    await other.getByRole('button',{name:circleId!,exact:true}).click();
    await expect(other.getByRole('heading',{name:circleId!,exact:true})).toBeVisible();

    circles = await senderApi<{id:string;revision:string}[]>('/v1/social/circles');
    expect(circles).toHaveLength(1);
    await senderApi(`/v1/social/circles/${circles[0]!.id}/remove`, {
      participant_id: recipientSession.participantId,
      expected_revision: circles[0]!.revision,
    });
    // A different client removed access: long polling must reset both list and
    // selected detail without a Refresh click or navigation by the recipient.
    await expect(other.getByRole('button',{name:circleId!,exact:true})).toHaveCount(0,{timeout:35_000});
    await expect(other.getByRole('heading',{name:circleId!,exact:true})).toHaveCount(0);
    await expect(other.getByText('Up to date',{exact:true})).toBeVisible();
    expect(await other.evaluate(()=>({local:Object.keys(localStorage).filter(key=>key!=='larynx.locale'),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
  } finally {await recipientContext.close();}
  expect(errors).toEqual([]);
});
