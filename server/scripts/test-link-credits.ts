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
import { recordCredit } from '../src/services/credits';
import { creditRecentLinkSends, creditUtmLinks, refreshShortLinkCodes, tidyLinkCredits } from '../src/services/linkCredits';

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
  await pool.query(`TRUNCATE link_sends, collections, caller_credits, crm_links, lead_activities, donations, people, leads, users RESTART IDENTITY CASCADE`);
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

  console.log('\n11. a PhonePe collection whose receipt DRM raised comes back from the site');
  // Manas (here Bhavin) collected ₹5,551 by PhonePe; Ana had sent this donor a link two days before.
  const donorLead = await lead('9820085002', 'Dharmapuri Chekkala', BHAVIN);
  await pool.query(
    `INSERT INTO lead_activities (lead_id, user_id, kind, note, to_value, occurred_at)
     VALUES ($1, $2, 'whatsapp', 'link', 'https://harekrishnavizag.org/annadan', NOW() - INTERVAL '2 days')`,
    [donorLead, ANA]
  );
  const col = await recordCredit({ kind: 'offline', userId: BHAVIN, amount: 5551, occurredAt: new Date().toISOString(), note: 'Dharmapuri Chekkala, collected by PhonePe' });
  await pool.query(
    `INSERT INTO collections (credit_id, donor_name, donor_phone, method, reference, receipt_status, receipt_number, external_donation_id)
     VALUES ($1, 'Dharmapuri Chekkala', '9820085002', 'phonepe', '628819282189', 'issued', 'HKMI|2026|D|VSP|13932', 'site-don-13932')`,
    [col!.id]
  );
  // The site's copy, as the sync brings it in: entered on the admin, no UTM.
  await upsertDonorSnapshot(
    { donor: { name: 'Dharmapuri Chekkala', mobile: '9820085002', donorSince: new Date().toISOString() },
      donations: [{ externalId: 'site-don-13932', amount: 5551, type: 'Annadana Seva', status: 'completed', createdAt: new Date().toISOString(),
                    isRecurring: false, sourcePage: 'admin-manual', paymentMode: 'upi' } as never] },
    'hkmv'
  );
  await creditRecentLinkSends();
  check('it is not counted again as a link payment', !(await credits(ANA)).some((x: any) => x.amount === 5551), await credits(ANA));
  await tidyLinkCredits();
  const colRow = (await pool.query(`SELECT donation_id FROM caller_credits WHERE id = $1`, [col!.id])).rows[0];
  const siteDon = (await pool.query(`SELECT id FROM donations WHERE external_ref = 'site-don-13932'`)).rows[0];
  check("the collection's credit is tied to the site's donation", colRow.donation_id === siteDon.id, { colRow, siteDon });
  check('so the money counts once, for Bhavin', (await pool.query(`SELECT COUNT(*)::int AS n FROM caller_credits WHERE amount = 5551 AND status = 'active'`)).rows[0].n === 1);

  console.log('\n12. one already counted twice (before this fix) is undone');
  await pay('9100000099', 2222, null, 'Counter Donor');
  const counter = (await pool.query(`SELECT id FROM donations WHERE amount = 2222`)).rows[0].id;
  await pool.query(`UPDATE donations SET source_page = 'admin-manual' WHERE id = $1`, [counter]);
  await recordCredit({ kind: 'link', userId: ANA, amount: 2222, occurredAt: new Date().toISOString(), donationId: counter, note: 'Donated within 7 days of being sent a link (Counter Donor)' });
  await tidyLinkCredits();
  const wrong = (await pool.query(`SELECT status, reversed_reason FROM caller_credits WHERE donation_id = $1`, [counter])).rows[0];
  check('reversed, with the reason', wrong.status === 'reversed' && /entered by hand/.test(wrong.reversed_reason), wrong);
  check('online link payments are left alone', (await credits(ANA)).some((x: any) => x.amount === 251));

  console.log('\n13. website short links: the code to track is the one the short link really sends');
  // A stand-in for the website. A short link is redirected to the address stored with it and the query on the
  // short address is thrown away, so that stored campaign is what a donation arrives with.
  const site = http.createServer((q, r) => {
    const code = /\/short-links\/resolve\/([^/?]+)/.exec(q.url ?? '')?.[1];
    const paths: Record<string, string> = {
      'ana-sqft': '/sqft-seva-campaign?utm_source=call&utm_medium=whatsapp&utm_campaign=ana-sqft-2',
      'ana-old': '/gau-seva?utm_source=call&utm_medium=whatsapp&utm_campaign=ana-old-2',
    };
    if (code === 'ana-down') { r.statusCode = 500; return r.end('{}'); }
    if (!code || !paths[code]) { r.statusCode = 404; return r.end('{}'); }
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ path: paths[code] }));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', () => r(null)));
  process.env.HKMV_API_URL = `http://127.0.0.1:${(site.address() as any).port}`;

  const short = await req('POST', '/api/crm/links', as(ANA), {
    label: 'Square Foot Seva Ana', url: 'https://www.harekrishnavizag.org/go/ana-sqft?utm_campaign=ana-square-foot-seva-ana', shared: false,
  });
  check("a short link is saved with the code the website sends, not one DRM makes up", short.status === 201 && short.utm_campaign === 'ana-sqft-2' && short.utm_source === 'call' && short.utm_medium === 'whatsapp', short);
  await pay('9000000010', 23100, 'ana-sqft-2', 'Big Donor');
  check('so a gift through it counts for Ana', (await credits(ANA)).some((x: any) => x.amount === 23100), await credits(ANA));

  const gone = await req('POST', '/api/crm/links', as(ANA), { label: 'Nothing', url: 'https://www.harekrishnavizag.org/go/ana-gone', shared: false });
  check('a short link that does not exist is refused', gone.status === 409 && /does not exist/.test(gone.error), gone);
  const down = await req('POST', '/api/crm/links', as(ANA), { label: 'Down', url: 'https://www.harekrishnavizag.org/go/ana-down', shared: false });
  check('and when the website cannot be asked it is not saved with a guess', down.status === 409 && /Try again/.test(down.error), down);
  check('nothing was saved for either', (await pool.query(`SELECT COUNT(*)::int AS n FROM crm_links WHERE label IN ('Nothing', 'Down')`)).rows[0].n === 0);

  console.log('\n14. a link saved with a made-up code (as before) is corrected, and the gift waiting for it counts');
  const oldLink = (await pool.query(
    `INSERT INTO crm_links (label, url, owner_user_id, created_by, utm_campaign)
     VALUES ('Gau Seva Ana', 'https://www.harekrishnavizag.org/go/ana-old?utm_campaign=ana-gau-seva-ana', $1, $1, 'ana-gau-seva-ana') RETURNING id`, [ANA])).rows[0].id;
  await pay('9000000011', 5000, 'ana-old-2', 'Waiting Donor');
  check('the gift matches nothing while the link holds the wrong code', !(await credits(ANA)).some((x: any) => x.amount === 5000), await credits(ANA));
  check('the check corrects the link', (await refreshShortLinkCodes(pool, true)) >= 1);
  const healed = (await pool.query(`SELECT utm_source, utm_medium, utm_campaign FROM crm_links WHERE id = $1`, [oldLink])).rows[0];
  check('to what the short link sends', healed.utm_campaign === 'ana-old-2' && healed.utm_source === 'call' && healed.utm_medium === 'whatsapp', healed);
  await creditUtmLinks();
  const waiting = (await credits(ANA)).filter((x: any) => x.amount === 5000);
  check('and the waiting gift is credited to Ana, once', waiting.length === 1 && waiting[0].kind === 'link', waiting);
  await creditUtmLinks();
  check('a second pass does not double it', (await credits(ANA)).filter((x: any) => x.amount === 5000).length === 1);
  check('a link already right is left alone', (await refreshShortLinkCodes(pool, true)) === 0);

  console.log('\n15. "Add my code" and copying keep the short link\'s own code');
  await pool.query(`UPDATE crm_links SET utm_campaign = NULL WHERE id = $1`, [oldLink]);
  const tracked = await req('POST', `/api/crm/links/${oldLink}/track`, as(ANA));
  check('Add my code reads the code from the website', tracked.status === 200 && tracked.utm_campaign === 'ana-old-2', tracked);
  const copy = await req('POST', `/api/crm/links/${short.id}/copy`, as(BHAVIN));
  check("a copy of Ana's short link carries no code of its own: it is the same link, so payments could not be told apart", copy.status === 201 && copy.utm_campaign === null, copy);
  await pay('9000000012', 777, 'ana-sqft-2', 'Another Donor');
  check('and its payments still count for Ana, not Bhavin', (await credits(ANA)).some((x: any) => x.amount === 777) && (await credits(BHAVIN)).every((x: any) => x.amount !== 777));
  site.close();

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
