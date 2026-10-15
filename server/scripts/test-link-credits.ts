// "Links a caller added, and the payments through them, are not adding to his
// account."
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-link-credits.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmLinksRoutes from '../src/routes/crmLinks';
import crmReportsRoutes from '../src/routes/crmReports';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';
import { creditRecentLinkSends, creditUtmLinks } from '../src/services/linkCredits';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmLinksRoutes);
app.use('/api/crm', crmReportsRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
const as = (id: string, role = 'caller') => ({ userId: id, role });

function req(method: string, path: string, who: { userId: string; role: string }, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { authorization: `Bearer ${generateToken({ userId: who.userId, email: 'x@t', role: who.role } as never)}`,
                   ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') }));
      }
    );
    r.on('error', reject);
    r.end(data ?? undefined);
  });
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 500));
  if (!ok) failures++;
};
const credits = async (user: string) =>
  (await pool.query(`SELECT kind, amount::int AS amount, note FROM caller_credits WHERE user_id = $1 AND status = 'active' ORDER BY occurred_at`, [user])).rows;
let ext = 0;
const pay = (mobile: string, amount: number, campaign: string | null, name = 'Donor', externalId?: string, src = 'call', medium = 'whatsapp') =>
  upsertDonorSnapshot(
    { donor: { name, mobile, donorSince: new Date().toISOString() },
      donations: [{ externalId: externalId ?? `lc-${++ext}`, amount, type: 'Gau seva', status: 'completed', createdAt: new Date().toISOString(), isRecurring: false,
                    utm: { source: src, medium, campaign } } as never] },
    'hkmv'
  );

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await pool.query(`TRUNCATE link_sends, caller_credits, crm_links, lead_activities, donations, people, leads, users RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller'), ($3,'Bhavin','b@t','x','caller')`,
    [ADMIN, ANA, BHAVIN]
  );
  const lead = async (phone: string, name: string, to: string) =>
    (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ($1, $2, $3) RETURNING id`, [phone, name, to])).rows[0].id as string;
  const l1 = await lead('9000000001', 'Ramesh', BHAVIN); // Bhavin's lead, but Ana sends the link
  const l2 = await lead('9000000002', 'Sita', ANA);
  const l3 = await lead('9000000003', 'Gopal', ANA);

  // As in production: the temple's seeded links carry utm_campaign=calling.
  await req('POST', '/api/crm/links', as(ADMIN, 'admin'), { label: 'Gau Seva (temple)', url: 'https://harekrishnavizag.org/gau-seva?utm_source=call&utm_campaign=calling' });

  console.log('\n1. Ana adds her own link and sends it');
  const generic = await req('POST', '/api/crm/links', as(ANA), { label: 'My Gau Seva', url: 'https://harekrishnavizag.org/gau-seva?utm_source=call&utm_campaign=calling', shared: false });
  check('utm_campaign=calling is refused: a temple link uses it', generic.status === 409 && /temple link/.test(generic.error), generic);
  const mine = await req('POST', '/api/crm/links', as(ANA), { label: 'My Gau Seva', url: 'https://harekrishnavizag.org/gau-seva?utm_source=call', shared: false });
  check('without one, her link is saved with her own code', mine.status === 201 && mine.utm_campaign === 'ana-my-gau-seva', mine);
  const sent = await req('POST', `/api/crm/leads/${l1}/send-link`, as(ANA), { link_id: mine.id });
  const token = new URL(sent.url).searchParams.get('utm_campaign');
  check('the link goes out with her code', sent.status === 200 && token === 'ana-my-gau-seva', sent.url);

  console.log('\n2. Ramesh pays through it');
  await pay('9000000001', 1100, token, 'Ramesh');
  let a = await credits(ANA);
  check('₹1,100 counts for Ana, who sent it', a.length === 1 && a[0].kind === 'link' && a[0].amount === 1100, a);
  check('not for Bhavin, whose lead it is', (await credits(BHAVIN)).length === 0);
  await req('GET', '/api/crm/dashboard', as(ADMIN, 'admin')); // runs the lead conversion
  check('the conversion does not credit it a second time', (await credits(ANA)).length === 1 && (await credits(BHAVIN)).length === 0, { ana: await credits(ANA), bhavin: await credits(BHAVIN) });
  await pay('9000000001', 1100, token, 'Ramesh', 'lc-1'); // the same donation synced again
  check('a re-sync does not double it', (await credits(ANA)).length === 1);

  console.log('\n3. a shared link nobody was assigned');
  const shared = await req('POST', '/api/crm/links', as(ADMIN, 'admin'), { label: 'Annadan', url: 'https://annadan.harekrishnavizag.org/' });
  const s2 = await req('POST', `/api/crm/leads/${l2}/send-link`, as(ANA), { link_id: shared.id });
  await pay('9000000002', 501, new URL(s2.url).searchParams.get('utm_campaign'), 'Sita');
  a = await credits(ANA);
  check('counts for whoever sent it', a.length === 2 && a[1].amount === 501, a);

  console.log('\n4. a shared link the admin assigned to Bhavin keeps going to Bhavin');
  const camp = await req('POST', '/api/crm/links', as(ADMIN, 'admin'), { label: 'Kartik campaign', url: 'https://harekrishnavizag.org/kartik' });
  await req('PUT', `/api/crm/links/${camp.id}/credit`, as(ADMIN, 'admin'), { user_id: BHAVIN });
  const s3 = await req('POST', `/api/crm/leads/${l3}/send-link`, as(ANA), { link_id: camp.id });
  await pay('9000000003', 2100, new URL(s3.url).searchParams.get('utm_campaign'), 'Gopal');
  const b = await credits(BHAVIN);
  check("the admin's choice stands", b.length === 1 && b[0].amount === 2100, b);

  console.log('\n5. payments made before this, with no code');
  const old = await lead('9000000004', 'Old Donor', BHAVIN);
  await pool.query(
    `INSERT INTO lead_activities (lead_id, user_id, kind, note, to_value, occurred_at)
     VALUES ($1, $2, 'whatsapp', 'link', 'https://harekrishnavizag.org/gau-seva', NOW() - INTERVAL '2 days')`,
    [old, ANA]
  );
  await pay('9000000004', 251, 'calling', 'Old Donor');
  const lateLead = await lead('9000000005', 'Too Late', BHAVIN);
  await pool.query(
    `INSERT INTO lead_activities (lead_id, user_id, kind, note, to_value, occurred_at)
     VALUES ($1, $2, 'whatsapp', 'link', 'https://harekrishnavizag.org/gau-seva', NOW() - INTERVAL '10 days')`,
    [lateLead, ANA]
  );
  await pay('9000000005', 999, null, 'Too Late');
  const n = await creditRecentLinkSends();
  a = await credits(ANA);
  check('a payment within 7 days of Ana sending the link counts for her', n === 1 && a.some((x: any) => x.amount === 251), { n, a });
  check('one 10 days later does not', !a.some((x: any) => x.amount === 999));
  check('running again credits nothing twice', (await creditRecentLinkSends()) === 0);

  console.log('\n6. a QR payment is never credited again as a link payment');
  const qrLead = await lead('9000000006', 'QR Donor', BHAVIN);
  await pool.query(
    `INSERT INTO lead_activities (lead_id, user_id, kind, note, to_value, occurred_at) VALUES ($1, $2, 'whatsapp', 'link', 'https://x.org/a', NOW() - INTERVAL '1 day')`,
    [qrLead, ANA]
  );
  await pay('9000000006', 700, null, 'QR Donor');
  const don = (await pool.query(`SELECT id FROM donations ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at, donation_id) VALUES ('pay_x', 'qr_x', 700, 'captured', NOW(), $1)`,
    [don]
  ).catch(async (e) => { console.log('  (qr_payments insert):', e.message); });
  await creditRecentLinkSends();
  check("left to the QR payment's own credit", !(await credits(ANA)).some((x: any) => x.amount === 700));

  console.log('\n7. Ana\'s own UTM link, shared on her WhatsApp status (DRM never sees the send)');
  const own = await req('POST', '/api/crm/links', as(ANA), {
    label: 'Diwali', url: 'https://harekrishnavizag.org/diwali?utm_source=whatsapp&utm_medium=status&utm_campaign=ana-diwali', shared: false });
  check('saved with her code', own.status === 201 && own.utm_campaign === 'ana-diwali' && own.utm_source === 'whatsapp', own);
  const clash = await req('POST', '/api/crm/links', as(BHAVIN), {
    label: 'Mine', url: 'https://harekrishnavizag.org/diwali?utm_campaign=ana-diwali', shared: false });
  check("Bhavin cannot use Ana's code", clash.status === 409 && /already used by Ana/.test(clash.error), clash);
  const auto = await req('POST', '/api/crm/links', as(ANA), { label: 'Gau Seva Daily', url: 'https://harekrishnavizag.org/gau-seva', shared: false });
  check('a link with no code gets hers: ana-gau-seva-daily', auto.utm_campaign === 'ana-gau-seva-daily' && auto.url.includes('utm_campaign=ana-gau-seva-daily'), auto);
  const before = (await credits(ANA)).length;
  await pay('9100000001', 5001, 'ana-diwali', 'Stranger One', undefined, 'whatsapp', 'status');
  let a7 = await credits(ANA);
  check('a stranger pays through it: ₹5,001 counts for Ana', a7.length === before + 1 && a7.some((x: any) => x.amount === 5001), a7);
  await pay('9100000002', 251, 'ANA-Diwali ', 'Stranger Two', undefined, 'WhatsApp', 'status');
  check('the code is read whatever its case', (await credits(ANA)).some((x: any) => x.amount === 251));
  await pay('9100000003', 333, 'ana-diwali', 'Stranger Three', undefined, 'instagram', 'status');
  check('a different utm_source than her link has does not count', !(await credits(ANA)).some((x: any) => x.amount === 333));
  await pay('9100000004', 108, 'ana-gau-seva-daily', 'Stranger Four', undefined, '', '');
  check('her auto code works too', (await credits(ANA)).some((x: any) => x.amount === 108));

  console.log('\n8. payments that arrived before she saved the link');
  await pay('9100000005', 1008, 'ana-old-campaign', 'Early Bird', undefined, 'whatsapp', 'status');
  check('nobody yet', !(await credits(ANA)).some((x: any) => x.amount === 1008));
  await req('POST', '/api/crm/links', as(ANA), { label: 'Old', url: 'https://harekrishnavizag.org/x?utm_campaign=ana-old-campaign', shared: false });
  const caught = await creditUtmLinks();
  check('credited to Ana once she saves it', caught === 1 && (await credits(ANA)).some((x: any) => x.amount === 1008), caught);
  check('and only once', (await creditUtmLinks()) === 0);

  console.log('\n9. a code a temple link uses credits nobody');
  const temple = await req('POST', '/api/crm/links', as(ADMIN, 'admin'), { label: 'Temple', url: 'https://harekrishnavizag.org/t?utm_campaign=calling' });
  await pay('9100000006', 777, 'calling', 'General Donor');
  await creditUtmLinks();
  check('utm_campaign=calling counts for nobody', !(await pool.query(`SELECT 1 FROM caller_credits WHERE amount = 777`)).rows.length);
  const copied = await req('POST', `/api/crm/links/${temple.id}/copy`, as(ANA), {});
  check("copying it to My links gives Ana's copy her own code", copied.status === 201 && copied.utm_campaign === 'ana-temple' && copied.url.includes('utm_campaign=ana-temple'), copied);

  console.log('\n10. My links shows what came in');
  const list = await req('GET', '/api/crm/links', as(ANA));
  const diwali = (list.links ?? []).find((l: any) => l.id === own.id);
  check('tracked, ₹5,252 from 2 payments', diwali?.tracked === true && Number(diwali.raised) === 5252 && diwali.payments === 2, diwali);
  check('the temple link is not "tracked"', (list.links ?? []).find((l: any) => l.id === temple.id)?.tracked === false);
  const sentOwn = await req('POST', `/api/crm/leads/${l2}/send-link`, as(ANA), { link_id: own.id });
  check('sending her own link from DRM keeps her code', new URL(sentOwn.url).searchParams.get('utm_campaign') === 'ana-diwali', sentOwn.url);
  check("Bhavin cannot put his code on Ana's link", (await req('POST', `/api/crm/links/${own.id}/track`, as(BHAVIN))).status === 403);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
