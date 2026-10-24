/**
 * The seva wall: who is on it, how a brick moves from print to review to sent,
 * who may do what, and that nothing is ever deleted.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-seva-wall.ts
 */
import '../src/bootTimezone';
// Reminders wait until 9am in real use; the test must not depend on the clock.
process.env.SEVA_REMINDER_FROM_HOUR = '0';
// The test donations are dated from August; the wall's real start day (1 Sep) is tested at the end.
process.env.SEVA_WALL_FROM = '2026-01-01';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken, confineRole } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import sevaWallRoutes, { raiseWallReminders, wallStart } from '../src/routes/sevaWall';
import sevaWallPublic from '../src/routes/sevaWallPublic';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', confineRole('brick_printer', ['/seva-wall', '/auth/me']));
app.use('/api/seva-wall', sevaWallRoutes);
app.use(sevaWallPublic);
// Stands in for "any other part of DRM" to prove the printer cannot reach it.
app.get('/api/people', (_req, res) => res.json({ people: ['secret'] }));
let base = '';

const ids = {
  admin: '11111111-1111-1111-1111-111111111111',
  printer: '22222222-2222-2222-2222-222222222222',
  caller: '33333333-3333-3333-3333-333333333333',
  accountant: '44444444-4444-4444-4444-444444444444',
};
const tokens = Object.fromEntries(
  (Object.keys(ids) as (keyof typeof ids)[]).map((r) => [
    r,
    generateToken({ userId: ids[r], email: `${r}@t`, role: r === 'printer' ? 'brick_printer' : r } as never),
  ])
) as Record<keyof typeof ids, string>;

const call = (as: keyof typeof ids | null, method: string, path: string, body?: unknown) =>
  new Promise<any>((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: {
          ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const type = String(res.headers['content-type'] ?? '');
          if (type.startsWith('image/')) return resolve({ http: res.statusCode, type, bytes: raw.length });
          try { resolve({ http: res.statusCode, ...JSON.parse(raw.toString() || '{}') }); }
          catch { resolve({ http: res.statusCode }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

/** A plain fetch of a public address: no login, the body as text. */
const getRaw = (path: string) =>
  new Promise<{ http: number; type: string; text: string; bytes: number }>((resolve, reject) => {
    const u = new URL(path.startsWith('http') ? path : `${base}${path}`);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ http: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: raw.toString('utf8'), bytes: raw.length });
      });
    }).on('error', reject);
  });

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const B64 = PNG.toString('base64');
const pic = { mime: 'image/png', base64: B64 };

async function main() {
  const m = await runMigrations();
  check('the migration applies', m.ok, true);

  await pool.query(`TRUNCATE drm_notifications, seva_wall_items, leads, donations, person_names, people, users RESTART IDENTITY CASCADE`);
  for (const [role, id] of Object.entries(ids)) {
    await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,$2,$3,'x',$4)`,
      [id, role, `${role}@t`, role === 'printer' ? 'brick_printer' : role]);
  }

  const person = async (name: string, phone: string) =>
    (await pool.query(`INSERT INTO people (name, phone) VALUES ($1,$2) RETURNING id`, [name, phone])).rows[0].id as string;
  const gift = async (pid: string, amount: number, purpose: string, opts: { site?: string; given?: string | null; sevak?: string | null; receipt?: string | null; at?: string } = {}) =>
    (await pool.query(
      `INSERT INTO donations (person_id, amount, payment_mode, purpose, source_site, given_name, sevak_name, receipt_number, created_at)
       VALUES ($1,$2,'upi',$3,$4,$5,$6,$7,COALESCE($8::timestamptz, NOW())) RETURNING id`,
      [pid, amount, purpose, opts.site ?? 'hkmv', opts.given ?? null, opts.sevak ?? null, opts.receipt ?? null, opts.at ?? null]
    )).rows[0].id as string;

  const a = await person('Asha Rao', '9000000001');
  const b = await person('Bala K', '9000000002');
  const hid = await person('Hidden One', '9000000003');

  const oldBrick = await gift(a, 1500, 'Brick Seva', { given: 'Meena Rao', sevak: 'Late Sri Rao', receipt: 'R-1', at: '2026-08-01T10:00:00+05:30' });
  const midSqft = await gift(b, 5000, 'Square foot seva', { receipt: 'R-2', at: '2026-09-01T10:00:00+05:30' });
  const newBrick = await gift(a, 2100, 'Brick Seva', { receipt: 'R-3', at: '2026-10-20T10:00:00+05:30' });
  const mandir = await gift(b, 2001, 'Mandir nirmana seva', { receipt: 'R-4', at: '2026-10-01T10:00:00+05:30' });
  await gift(a, 1499, 'Brick Seva');
  await gift(b, 100000, 'Annadan');
  await gift(b, 3000, 'Brick Seva', { site: 'annadan' });
  const hiddenGift = await gift(hid, 2500, 'Square foot seva');
  await pool.query(`UPDATE people SET hidden_at = NOW(), hidden_reason = 't' WHERE id = $1`, [hid]);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  console.log('\n--- who is on the wall ---');
  let r = await call('admin', 'GET', '/api/seva-wall?view=all');
  check('the four qualifying donations, nothing else', r.total, 4);
  check('Rs 1,499, another seva, annadan and a hidden donor are all left out',
    r.rows.some((x: any) => [1499, 100000, 3000].includes(x.amount) || x.ref === hiddenGift), false);
  check('every one starts as "to print", medium', [...new Set(r.rows.map((x: any) => `${x.status}/${x.priority}`))], ['to_print/medium']);
  const row = r.rows.find((x: any) => x.ref === oldBrick);
  check('donor name, honoree, phone, amount, receipt', [row.donor_name, row.honoree_name, row.phone, row.amount, row.receipt_number],
    ['Meena Rao', 'Late Sri Rao', '9000000001', 1500, 'R-1']);

  console.log('\n--- add a record by hand ---');
  const good = { donor_name: 'Walk In', phone: '98 76 54 32 10', amount: 2500, receipt_number: 'BOOK-77', kind: 'brick', priority: 'high' };
  check('needs the amount', (await call('admin', 'POST', '/api/seva-wall', { ...good, amount: '' })).http, 400);
  check('below Rs 1,500 is refused', (await call('admin', 'POST', '/api/seva-wall', { ...good, amount: 1000 })).http, 400);
  check('needs a 10-digit phone', (await call('admin', 'POST', '/api/seva-wall', { ...good, phone: '123' })).http, 400);
  check('a receipt that is already a donation is refused', (await call('admin', 'POST', '/api/seva-wall', { ...good, receipt_number: 'r-1' })).http, 409);
  const added = await call('admin', 'POST', '/api/seva-wall', good);
  check('a complete record is added', added.http, 201);
  check('the same receipt twice is refused', (await call('admin', 'POST', '/api/seva-wall', good)).http, 409);
  check('only an admin can add one', (await call('caller', 'POST', '/api/seva-wall', { ...good, receipt_number: 'X' })).http, 403);
  check('...not the printer either', (await call('printer', 'POST', '/api/seva-wall', { ...good, receipt_number: 'X' })).http, 403);
  r = await call('admin', 'GET', '/api/seva-wall?view=all');
  const manual = r.rows.find((x: any) => x.ref === added.ref);
  check('it is on the wall, as a hand-entered record', [r.total, manual.origin, manual.phone, manual.priority], [5, 'manual', '9876543210', 'high']);
  check('and no donation was created for it', (await pool.query(`SELECT COUNT(*)::int AS n FROM donations`)).rows[0].n, 8);

  console.log('\n--- priority ---');
  check('an admin sets it', (await call('admin', 'PATCH', `/api/seva-wall/${midSqft}`, { priority: 'high' })).http, 200);
  check('only high / medium / low', (await call('admin', 'PATCH', `/api/seva-wall/${midSqft}`, { priority: 'urgent' })).http, 400);
  check('a caller cannot', (await call('caller', 'PATCH', `/api/seva-wall/${midSqft}`, { priority: 'low' })).http, 403);
  check('a donation that is not on the wall is refused', (await call('admin', 'PATCH', `/api/seva-wall/${hiddenGift}`, { priority: 'low' })).http, 404);
  await call('admin', 'PATCH', `/api/seva-wall/${newBrick}`, { priority: 'low' });

  console.log('\n--- the printer sees one list, oldest and most urgent first ---');
  r = await call('printer', 'GET', '/api/seva-wall');
  check('the print list is all they get', [r.view, r.views], ['print', ['print']]);
  // high: manual (added today, as created_at) and midSqft (Sep 1) -> oldest first = midSqft then manual
  // medium: oldBrick (Aug 1), mandir (Oct 1); low: newBrick
  check('high first, then medium, then low - oldest first inside each',
    r.rows.map((x: any) => x.ref), [midSqft, added.ref, oldBrick, mandir, newBrick]);
  check('asking for another list still gives the print list', (await call('printer', 'GET', '/api/seva-wall?view=review')).view, 'print');
  check('they never see a phone, an amount or a receipt',
    r.rows.some((x: any) => 'phone' in x || 'amount' in x || 'receipt_number' in x || 'image_url' in x), false);
  check('but they do see the names to print', [r.rows[2].donor_name, r.rows[2].honoree_name], ['Meena Rao', 'Late Sri Rao']);
  check('searching by phone finds nothing for them', (await call('printer', 'GET', '/api/seva-wall?search=9000000001')).total, 0);

  console.log('\n--- the printer is shut out of the rest of DRM ---');
  check('another part of the API answers 403', (await call('printer', 'GET', '/api/people')).http, 403);
  check('the same route works for an admin', (await call('admin', 'GET', '/api/people')).http, 200);
  check('and with no token the guard stays out of the way', (await call(null, 'GET', '/api/people')).http, 200);
  check('the printer can see no picture for a brick that is not theirs to replace', (await call('printer', 'GET', `/api/seva-wall/${oldBrick}/image`)).http, 404);
  check('or review one', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/mark-sent`)).http, 403);

  console.log('\n--- uploading the printed brick ---');
  check('a non-image is refused', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/image`, { mime: 'application/pdf', base64: B64 })).http, 400);
  check('over 5 MB is refused', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/image`, { mime: 'image/png', base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })).http, 413);
  check('a donation that is not on the wall is refused', (await call('printer', 'POST', `/api/seva-wall/${hiddenGift}/image`, pic)).http, 404);
  check('a malformed id is a 404, not a 500', (await call('printer', 'POST', '/api/seva-wall/nope/image', pic)).http, 404);
  check('a caller cannot upload', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/image`, pic)).http, 403);
  const up = await call('printer', 'POST', `/api/seva-wall/${oldBrick}/image`, pic);
  check('the printer uploads: it moves to review', [up.http, up.status], [201, 'in_review']);
  check('the very same picture again is refused', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/image`, pic)).http, 409);
  r = await call('printer', 'GET', '/api/seva-wall?stage=uploaded');
  check('the printer can see what they uploaded, with its picture', [r.total, r.rows[0].ref, r.rows[0].has_image], [1, oldBrick, true]);
  check('and look at it', (await call('printer', 'GET', `/api/seva-wall/${oldBrick}/image`)).http, 200);
  check('their counts include it', (await call('printer', 'GET', '/api/seva-wall?stage=uploaded')).counts.uploaded, 1);
  const better = await call('printer', 'POST', `/api/seva-wall/${oldBrick}/image`, { mime: 'image/png', base64: Buffer.from('a better picture').toString('base64') });
  check('not good? a new picture replaces it', [better.http, better.replaced], [201, true]);
  check('and the old one is deleted - only one picture is ever kept',
    (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_wall_pictures`)).rows[0].n, 1);
  r = await call('printer', 'GET', '/api/seva-wall');
  check('it leaves the printer\'s list', r.rows.some((x: any) => x.ref === oldBrick), false);

  console.log('\n--- the reviewer ---');
  r = await call('caller', 'GET', '/api/seva-wall');
  check('a caller gets the Seva wall table, only', [r.view, r.views, r.total], ['contact', ['contact'], 1]);
  check('with the phone to call and the picture flag', [r.rows[0].ref, r.rows[0].phone, r.rows[0].has_image], [oldBrick, '9000000001', true]);
  check('a caller asking for the print list gets the Seva wall table instead', (await call('caller', 'GET', '/api/seva-wall?view=print')).view, 'contact');
  check('a printer cannot mark a call', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/called`)).http, 403);
  check('a brick with no picture yet cannot be marked called', (await call('caller', 'POST', `/api/seva-wall/${added.ref}/called`)).http, 409);
  const called1 = await call('caller', 'POST', `/api/seva-wall/${oldBrick}/called`);
  check('call answered is recorded', [called1.http, called1.called], [200, true]);
  r = await call('caller', 'GET', '/api/seva-wall');
  check('...with who called', [r.rows[0].called_by_name, !!r.rows[0].called_at], ['caller', true]);

  console.log('\n--- the link the donor opens (WhatsApp preview card) ---');
  const share: string = r.rows[0].share_url;
  check('the caller gets a share link for a brick with a picture', /^http:\/\/127\.0\.0\.1:\d+\/b\/[0-9a-f]{32}$/.test(share), true);
  const page = await getRaw(share);
  check('it opens with no login', [page.http, page.type.startsWith('text/html')], [200, true]);
  check('it carries the picture for the preview card', /<meta property="og:image" content="[^"]+\/b\/[0-9a-f]{32}\/image">/.test(page.text), true);
  check('and the title, with the name on the brick and the seva', [page.text.includes('og:title'), page.text.includes('Late Sri Rao'), page.text.includes('Brick seva')], [true, true, true]);
  check('but no phone, amount or receipt', ['9000000001', '1500', 'R-1'].some((x) => page.text.includes(x)), false);
  const pic2 = await getRaw(`${share}/image`);
  check('the picture is served without a login', [pic2.http, pic2.type, pic2.bytes], [200, 'image/png', Buffer.from('a better picture').length]);
  check('a made-up link is a 404', (await getRaw('/b/' + '0'.repeat(32))).http, 404);
  check('a malformed link is a 404', (await getRaw('/b/not-a-token')).http, 404);
  check('the printer is never given the link', (await call('printer', 'GET', '/api/seva-wall?stage=uploaded')).rows.some((x: any) => 'share_url' in x), false);
  check('once a caller has called, the printer can no longer replace the picture',
    (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/image`, { mime: 'image/png', base64: Buffer.from('too late').toString('base64') })).http, 409);
  check('...but can still look at the picture they uploaded', (await call('printer', 'GET', `/api/seva-wall/${oldBrick}/image`)).http, 200);
  const img = await call('caller', 'GET', `/api/seva-wall/${oldBrick}/image`);
  check('the picture comes back as an image', [img.http, img.type, img.bytes], [200, 'image/png', Buffer.from('a better picture').length]);
  check('sending back needs a reason', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/send-back`, { note: '  ' })).http, 400);
  const back = await call('caller', 'POST', `/api/seva-wall/${oldBrick}/send-back`, { note: 'Name is cut off' });
  check('sent back: needs a reprint', [back.http, back.status], [200, 'needs_reprint']);
  check('the rejected picture waits, marked sent back, until the new one arrives', (await pool.query(`SELECT state, sent_back_note FROM seva_wall_pictures`)).rows, [{ state: 'sent_back', sent_back_note: 'Name is cut off' }]);
  r = await call('printer', 'GET', '/api/seva-wall');
  const again = r.rows.find((x: any) => x.ref === oldBrick);
  check('it is back on the printer\'s list with the reason', [!!again, again?.status, again?.review_note], [true, 'needs_reprint', 'Name is cut off']);
  check('and at the TOP of it, ahead of every urgent brick', r.rows[0].ref, oldBrick);
  check('the printer is told a picture was sent back and can see it', [again?.has_previous_image, (await call('printer', 'GET', `/api/seva-wall/${oldBrick}/image?which=previous`)).http], [true, 200]);
  check('the sent-back picture is the old one, not a new one', (await call('printer', 'GET', `/api/seva-wall/${oldBrick}/image?which=previous`)).bytes, Buffer.from('a better picture').length);
  check('a brick that was never sent back has no previous picture', (await call('printer', 'GET', `/api/seva-wall/${hiddenGift}/image?which=previous`)).http, 404);

  console.log('\n--- the conversation on a brick ---');
  let thread = await call('printer', 'GET', `/api/seva-wall/${oldBrick}/messages`);
  check('the reason it was sent back is the first message, by the caller', [thread.messages.length, thread.messages[0].kind, thread.messages[0].note, thread.messages[0].by_role], [1, 'sent_back', 'Name is cut off', 'caller']);
  check('a caller cannot write on a brick that is out for reprint until the printer has asked', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'hello' })).http, 404);
  check('an empty message is refused', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: '   ' })).http, 400);
  check('the printer asks what is not clear', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'What is not clear in the picture?' })).http, 201);
  r = await call('printer', 'GET', '/api/seva-wall');
  check('the printer sees it is waiting for an answer', r.rows.find((x: any) => x.ref === oldBrick).awaiting_reply, true);
  r = await call('caller', 'GET', '/api/seva-wall');
  const asked = r.rows.find((x: any) => x.ref === oldBrick);
  check('the brick is on the caller\'s Seva wall table, first, with the question', [r.rows[0]?.ref, asked?.awaiting_reply, asked?.status, asked?.message_count], [oldBrick, true, 'needs_reprint', 2]);
  check('the caller can see the picture that was sent back', [asked?.has_previous_image, (await call('caller', 'GET', `/api/seva-wall/${oldBrick}/image?which=previous`)).http], [true, 200]);
  check('and the tally says one question is waiting', r.counts.questions, 1);
  check('the callers are told in the bell', (await pool.query(`SELECT COUNT(*)::int AS n FROM drm_notifications WHERE ref_key LIKE 'swq:%' AND title LIKE 'Printer question%'`)).rows[0].n, 1);
  check('the caller reads the whole conversation', (await call('caller', 'GET', `/api/seva-wall/${oldBrick}/messages`)).messages.length, 2);
  check('and cannot do what the printer is waiting on - call or send it on', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/mark-sent`)).http, 409);
  check('an accountant cannot join in', (await call('accountant', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'hi' })).http, 403);
  check('the caller answers', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'The name at the bottom is faint' })).http, 201);
  check('it leaves the caller\'s table once answered', (await call('caller', 'GET', '/api/seva-wall')).rows.some((x: any) => x.ref === oldBrick), false);
  r = await call('printer', 'GET', '/api/seva-wall');
  const answered = r.rows.find((x: any) => x.ref === oldBrick);
  check('the printer sees the answer: no longer waiting, the caller spoke last', [answered.awaiting_reply, answered.last_message_role, answered.message_count], [false, 'caller', 3]);
  check('the admin can add to it too', (await call('admin', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'Please use a darker print' })).http, 201);
  thread = await call('printer', 'GET', `/api/seva-wall/${oldBrick}/messages`);
  check('the printer sees all four, in order', thread.messages.map((m: any) => m.by_role), ['caller', 'brick_printer', 'caller', 'admin']);
  check('a message never carries a phone number or an amount', JSON.stringify(thread).includes('phone'), false);
  check('an admin working the print list asks the callers the same way',
    (await call('admin', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'Is the spelling right?', ask: true })).http, 201);
  check('so it is on the caller\'s table', (await call('caller', 'GET', '/api/seva-wall')).rows.some((x: any) => x.ref === oldBrick && x.awaiting_reply), true);
  check('and the caller answers it', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'Yes, it is right' })).http, 201);
  check('and it is off the caller\'s table again', (await call('caller', 'GET', '/api/seva-wall')).rows.some((x: any) => x.ref === oldBrick), false);
  check('a brick nobody has written on has an empty conversation', (await call('printer', 'GET', `/api/seva-wall/${hiddenGift}/messages`)).messages.length, 0);

  check('a new round of calling starts: the called mark is cleared',
    (await pool.query(`SELECT called_at FROM seva_wall_items WHERE donation_id = $1`, [oldBrick])).rows[0].called_at, null);
  check('it is not in review any more', (await call('caller', 'GET', '/api/seva-wall')).total, 0);
  check('a brick sent back has nothing to show: its link is not available', (await getRaw(share)).http, 404);
  check('a brick that is not in review cannot be marked sent', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/mark-sent`)).http, 409);
  check('...or sent back again', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/send-back`, { note: 'x' })).http, 409);

  check('the printer says they will redo it - a question again', (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'I will redo it now' })).http, 201);
  check('so it is on the caller\'s table again', (await call('caller', 'GET', '/api/seva-wall')).rows.some((x: any) => x.ref === oldBrick), true);
  const reup = await call('printer', 'POST', `/api/seva-wall/${oldBrick}/image`, pic);
  check('a new picture ends the question', (await pool.query(`SELECT awaiting_reply_at FROM seva_wall_items WHERE donation_id = $1`, [oldBrick])).rows[0].awaiting_reply_at, null);
  check('a note with the new picture is only a note, not a question',
    (await call('printer', 'POST', `/api/seva-wall/${oldBrick}/messages`, { note: 'Darker now' })).http === 201 &&
      (await pool.query(`SELECT awaiting_reply_at FROM seva_wall_items WHERE donation_id = $1`, [oldBrick])).rows[0].awaiting_reply_at === null, true);
  check('the printer uploads a new picture', [reup.http, reup.status], [201, 'in_review']);
  check('the rejected picture was deleted when the new one came in', (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_wall_pictures`)).rows[0].n, 1);
  check('and the one left is the current one', (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_wall_pictures WHERE state = 'current'`)).rows[0].n, 1);
  r = await call('caller', 'GET', '/api/seva-wall');
  check('the reason is cleared once it is back in review', r.rows[0].review_note, null);

  const wa = await call('caller', 'POST', `/api/seva-wall/${oldBrick}/mark-sent`);
  check('WhatsApp sent, but the donor has not been reached: NOT finished', [wa.http, wa.status, wa.finished], [200, 'in_review', false]);
  r = await call('caller', 'GET', '/api/seva-wall');
  check('it shows both facts: WhatsApp sent, donor not reached', [r.rows[0].status, !!r.rows[0].whatsapp_sent_at, !!r.rows[0].called_at], ['in_review', true, false]);
  check('the donor\'s link keeps working', (await getRaw(share)).http, 200);
  check('a call that is answered needs what the donor said', (await call('caller', 'POST', `/api/seva-wall/${oldBrick}/call`, { outcome: 'answered' })).http, 400);
  const sent = await call('caller', 'POST', `/api/seva-wall/${oldBrick}/call`, { outcome: 'answered', note: 'Donor picked up and is happy with the picture' });
  check('a later answered call finishes it', [sent.http, sent.status], [200, 'sent']);
  check('the same link works again with the new picture, and after it is sent', (await getRaw(share)).http, 200);
  r = await call('caller', 'GET', '/api/seva-wall');
  check('it stays on the Seva wall table as sent, with who sent it', [r.total, r.rows[0].status, r.rows[0].sent_by_name], [1, 'sent', 'caller']);
  check('a sent brick cannot be uploaded over', (await call('admin', 'POST', `/api/seva-wall/${oldBrick}/image`, pic)).http, 409);

  console.log('\n--- the Seva wall table order ---');
  for (const id of [midSqft, newBrick, mandir]) {
    check(`the printer uploads ${id.slice(0, 4)}`, (await call('printer', 'POST', `/api/seva-wall/${id}/image`, pic)).http, 201);
    await new Promise((x) => setTimeout(x, 15));
  }
  check('a caller marks one called', (await call('caller', 'POST', `/api/seva-wall/${newBrick}/called`)).http, 200);
  check('marking called twice is harmless', (await call('caller', 'POST', `/api/seva-wall/${newBrick}/called`)).http, 200);
  r = await call('caller', 'GET', '/api/seva-wall');
  check('not called first (longest waiting first), then called, then sent',
    r.rows.map((x: any) => x.ref), [midSqft, mandir, newBrick, oldBrick]);
  check('stage: not called yet', (await call('caller', 'GET', '/api/seva-wall?stage=to_call')).total, 2);
  check('stage: called, picture not sent', (await call('caller', 'GET', '/api/seva-wall?stage=called')).total, 1);
  check('stage: sent', (await call('caller', 'GET', '/api/seva-wall?stage=sent')).total, 1);
  check('a caller\'s counts', r.counts, { to_call: 2, called: 1, sent: 1, due: 0, questions: 0 });
  check('the print list no longer has them', (await call('printer', 'GET', '/api/seva-wall')).total, 1);

  console.log('\n--- logging a call: answered or not, a note, and the day to call again ---');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const logCall = (as: any, id: string, b: unknown) => call(as, 'POST', `/api/seva-wall/${id}/call`, b);
  check('the outcome is required', (await logCall('caller', midSqft, { note: 'x' })).http, 400);
  check('a printer cannot log a call', (await logCall('printer', midSqft, { outcome: 'answered' })).http, 403);
  check('a follow-up day in the past is refused', (await logCall('caller', midSqft, { outcome: 'no_answer', follow_up_on: '2020-01-01' })).http, 400);
  check('a malformed date is refused', (await logCall('caller', midSqft, { outcome: 'no_answer', follow_up_on: 'soon' })).http, 400);
  check('a brick with no picture cannot have a call logged', (await logCall('caller', added.ref, { outcome: 'answered', note: 'x' })).http, 409);
  check('an answered call needs what the donor said', (await logCall('caller', midSqft, { outcome: 'answered', note: '  ' })).http, 400);
  check('a call nobody answered needs no details', (await logCall('caller', newBrick, { outcome: 'no_answer' })).http, 200);

  const noAns = await logCall('caller', mandir, { outcome: 'no_answer', note: 'Phone off. Try after 5pm', follow_up_on: inDays(3) });
  check('did not answer: counted as a try', [noAns.http, noAns.outcome, noAns.attempts], [200, 'no_answer', 1]);
  r = await call('caller', 'GET', '/api/seva-wall');
  let mm = r.rows.find((x: any) => x.ref === mandir);
  check('it is NOT marked called, and keeps the note and the day',
    [!!mm.called_at, mm.last_call_outcome, mm.last_call_note, mm.follow_up_on, mm.call_attempts], [false, 'no_answer', 'Phone off. Try after 5pm', inDays(3), 1]);
  check('a day to call again does not move the brick: not called, called, then sent',
    r.rows.map((x: any) => x.ref), [midSqft, mandir, newBrick, oldBrick]);

  const noAns2 = await logCall('caller', midSqft, { outcome: 'no_answer' });
  check('no answer, no day given: another try, still to call', [noAns2.attempts, (await call('caller', 'GET', '/api/seva-wall?stage=to_call')).total], [1, 2]);

  const ans = await logCall('caller', midSqft, { outcome: 'answered', note: 'Wants to donate another brick', follow_up_on: today });
  check('answered, with a note and today as the day to call back', [ans.http, ans.outcome, ans.attempts], [200, 'answered', 2]);
  r = await call('caller', 'GET', '/api/seva-wall');
  check('a follow-up that has come due is NOT pinned to the top: it is called now, so it sits with the called ones',
    r.rows.map((x: any) => x.ref), [mandir, midSqft, newBrick, oldBrick]);
  mm = r.rows.find((x: any) => x.ref === midSqft);
  check('...and is now marked called, with the note', [!!mm.called_at, mm.last_call_note, mm.follow_up_on], [true, 'Wants to donate another brick', today]);
  check('the due stage and count', [(await call('caller', 'GET', '/api/seva-wall?stage=due')).total, r.counts.due], [1, 1]);

  console.log('\n--- the reminder comes to the notification bell ---');
  process.env.SEVA_REMINDER_FROM_HOUR = '24';
  check('nothing is raised before the morning hour', await raiseWallReminders(), 0);
  process.env.SEVA_REMINDER_FROM_HOUR = '0';
  check('the follow-up that has come due is raised once', await raiseWallReminders(), 1);
  const bell = (await pool.query(`SELECT kind, title, body, link, phone FROM drm_notifications WHERE kind = 'seva_wall' AND title LIKE 'Call %'`)).rows;
  check('as a bell notification with the donor, what they said and who asked',
    bell, [{ kind: 'seva_wall', title: 'Call Bala K today', body: 'Square foot seva - Wants to donate another brick (asked by caller)', link: '/seva-wall?search=9000000002', phone: '9000000002' }]);
  check('running it again raises nothing new', [await raiseWallReminders(), (await pool.query(`SELECT COUNT(*)::int AS n FROM drm_notifications WHERE title LIKE 'Call %'`)).rows[0].n], [0, 1]);
  check('a day that has not come yet is not raised (the one set for 3 days ahead)', bell.some((n: any) => /Phone off/.test(n.body ?? '')), false);

  const kept = await logCall('caller', midSqft, { outcome: 'answered', note: 'Told him the picture is on its way' });
  check('a later call with no new day clears the old follow-up (the promise was kept)', [kept.http, kept.follow_up_on], [200, null]);
  check('so it is no longer due', (await call('caller', 'GET', '/api/seva-wall?stage=due')).total, 0);
  check('...and nothing more is raised', await raiseWallReminders(), 0);
  check('every call is on record, with who and when',
    (await pool.query(`SELECT e.action FROM seva_wall_events e JOIN seva_wall_items i ON i.id = e.item_id
                        WHERE i.donation_id = $1 ORDER BY e.id`, [midSqft])).rows.map((x: any) => x.action),
    ['uploaded', 'no_answer', 'called', 'called']);
  const waFirst = await call('caller', 'POST', `/api/seva-wall/${mandir}/mark-sent`);
  check('a WhatsApp before any answered call leaves it open', [waFirst.http, waFirst.status], [200, 'in_review']);
  const finish = await logCall('caller', mandir, { outcome: 'answered', note: 'Reached him, he got the picture' });
  check('an answered call with no new day then finishes it', [finish.http, finish.status], [200, 'sent']);
  check('...and the follow-up day is gone', (await pool.query(`SELECT follow_up_on FROM seva_wall_items WHERE donation_id = $1`, [mandir])).rows[0].follow_up_on, null);

  console.log('\n--- WhatsApp sent, the donor did not answer, answered later ---');
  const untouched = await call('admin', 'POST', '/api/seva-wall', { donor_name: 'Untouched One', phone: '9333333302', amount: 2400, kind: 'brick' });
  await call('printer', 'POST', `/api/seva-wall/${untouched.ref}/image`, { mime: 'image/png', base64: Buffer.from('untouched picture').toString('base64') });
  // This donor is ALREADY a lead in the normal calling system, in an open stage: the brick calls
  // must be written to that lead and leave its stage alone.
  await pool.query(`INSERT INTO leads (phone, name, status, assigned_to) VALUES ('9333333300', 'Later Answer', 'attempting', $1)`, [ids.admin]);
  const fresh = await call('admin', 'POST', '/api/seva-wall', { donor_name: 'Later Answer', phone: '9333333300', amount: 2200, kind: 'brick' });
  check('a brick is added and its picture uploaded', [fresh.http, (await call('printer', 'POST', `/api/seva-wall/${fresh.ref}/image`, { mime: 'image/png', base64: Buffer.from('later answer picture').toString('base64') })).http], [201, 201]);
  check('the caller sends the WhatsApp', (await call('caller', 'POST', `/api/seva-wall/${fresh.ref}/mark-sent`)).status, 'in_review');
  check('then rings, and the donor does not answer', (await logCall('caller', fresh.ref, { outcome: 'no_answer' })).http, 200);
  r = await call('caller', 'GET', '/api/seva-wall?stage=to_call');
  const row2 = r.rows.find((x: any) => x.ref === fresh.ref);
  check('it shows both: WhatsApp sent AND did not answer, still to call',
    [row2.status, !!row2.whatsapp_sent_at, !!row2.called_at, row2.last_call_outcome, row2.call_attempts], ['in_review', true, false, 'no_answer', 1]);
  check('another try that is not answered keeps it open', [(await logCall('caller', fresh.ref, { outcome: 'no_answer' })).status, (await call('caller', 'GET', '/api/seva-wall?stage=to_call')).rows.some((x: any) => x.ref === fresh.ref)], ['in_review', true]);
  r = await call('caller', 'GET', '/api/seva-wall');
  const order = r.rows.map((x: any) => x.ref);
  check('not called and no WhatsApp comes FIRST, ahead of one that was messaged but not reached',
    [order.indexOf(untouched.ref) < order.indexOf(fresh.ref), order.indexOf(untouched.ref)], [true, 0]);
  check('...and that comes ahead of the donors who were reached', order.indexOf(fresh.ref) < order.indexOf(midSqft), true);
  const later = await logCall('caller', fresh.ref, { outcome: 'answered', note: 'Said he will visit the temple on Sunday' });
  check('later he answers, the caller writes what he said, and it is finished', [later.http, later.status], [200, 'sent']);
  check('the note is kept', (await call('caller', 'GET', '/api/seva-wall?stage=sent')).rows.find((x: any) => x.ref === fresh.ref)?.last_call_note, 'Said he will visit the temple on Sunday');
  const withDay = await call('admin', 'POST', '/api/seva-wall', { donor_name: 'Call Back Soon', phone: '9333333301', amount: 2300, kind: 'brick' });
  await call('printer', 'POST', `/api/seva-wall/${withDay.ref}/image`, { mime: 'image/png', base64: Buffer.from('call back picture').toString('base64') });
  await call('caller', 'POST', `/api/seva-wall/${withDay.ref}/mark-sent`);
  const notYet = await logCall('caller', withDay.ref, { outcome: 'answered', note: 'Busy now, ring next week', follow_up_on: inDays(7) });
  check('answered but asked to be called again: not finished yet', [notYet.http, notYet.status], [200, 'in_review']);
  check('a final answered call with no new day then finishes it', (await logCall('caller', withDay.ref, { outcome: 'answered', note: 'Spoke, all done' })).status, 'sent');

  console.log('\n--- everyone else ---');
  check('an accountant can look', (await call('accountant', 'GET', '/api/seva-wall?view=all')).total, 8);
  check('but not upload', (await call('accountant', 'POST', `/api/seva-wall/${midSqft}/image`, pic)).http, 403);
  r = await call('admin', 'GET', '/api/seva-wall?view=all');
  check('the counts say where everything is', r.counts, { to_print: 1, needs_reprint: 0, to_call: 1, called: 2, sent: 4, due: 0, questions: 0 });
  check('filter by seva', (await call('admin', 'GET', '/api/seva-wall?view=all&kind=mandir')).total, 1);
  check('filter by priority', (await call('admin', 'GET', '/api/seva-wall?view=all&priority=high')).total, 2);
  check('search by receipt number', (await call('admin', 'GET', '/api/seva-wall?view=all&search=BOOK-77')).total, 1);

  console.log('\n--- a record without a receipt number ---');
  const noReceipt = await call('admin', 'POST', '/api/seva-wall', { donor_name: 'No Receipt', phone: '9222222222', amount: 1800, kind: 'square', priority: 'low' });
  check('the receipt number is optional', noReceipt.http, 201);
  check('the same record again is refused', (await call('admin', 'POST', '/api/seva-wall', { donor_name: 'no receipt', phone: '9222222222', amount: 1800, kind: 'square' })).http, 409);
  check('it still needs a name, phone, amount and seva', (await call('admin', 'POST', '/api/seva-wall', { donor_name: 'x', phone: '9222222223', amount: 1800 })).http, 400);

  console.log('\n--- bulk upload ---');
  const headers = ['Donor Name', 'Honoree', 'Mobile', 'Amount', 'Receipt No', 'Seva', 'Priority', 'Date'];
  const sheet = [
    ['Ravi Kumar', '', '98111 11111', '3,000', '', 'Brick seva', '', ''],            // 2: good, no priority -> medium
    ['Sita Devi', 'Late Ram', '9222222224', 'Rs 2500', 'B-1', 'Square foot', 'High', '05/09/2026'], // 3: good
    ['Bad Phone', '', '123', '2000', '', 'Brick', '', ''],                              // 4
    ['Low Amount', '', '9333333333', '1000', '', 'Brick', '', ''],                      // 5
    ['Wrong Seva', '', '9333333334', '2000', '', 'Annadan', '', ''],                    // 6
    ['Ravi Kumar', '', '9811111111', '3000', '', 'Brick', '', ''],                      // 7: repeat of row 2
    ['Has Receipt', '', '9333333335', '2000', 'r-1', 'Brick', '', ''],                  // 8: receipt already a donation
    ['Already There', '', '9000000002', '5000', '', 'Square foot', '', ''],             // 9: a donation is already on the wall
    ['', '', '', '', '', '', '', ''],                                                    // 10: blank line
  ];
  const body = (dry: boolean, h = headers, rows = sheet) => ({ headers: h, rows, dry_run: dry });
  check('only an admin can bulk upload', (await call('caller', 'POST', '/api/seva-wall/bulk', body(true))).http, 403);
  const noCols = await call('admin', 'POST', '/api/seva-wall/bulk', body(true, ['Donor Name', 'Mobile'], [['a', '1']]));
  check('a sheet missing columns says which', [noCols.http, noCols.missing], [400, ['Amount', 'Seva']]);
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_wall_items WHERE donation_id IS NULL`)).rows[0].n;
  const dry = await call('admin', 'POST', '/api/seva-wall/bulk', body(true));
  check('a dry run counts what would happen', [dry.ready, dry.problems, dry.duplicates], [2, 3, 3]);
  check('and says which sheet rows and why', dry.issues.map((x: any) => x.row), [4, 5, 6, 7, 8, 9]);
  check('...a repeat is called a repeat', dry.issues.find((x: any) => x.row === 7).message.startsWith('repeated in this file'), true);
  check('a dry run writes nothing', (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_wall_items WHERE donation_id IS NULL`)).rows[0].n, before);
  const real = await call('admin', 'POST', '/api/seva-wall/bulk', body(false));
  check('the real upload adds the good rows only', [real.added, real.problems, real.duplicates], [2, 3, 3]);
  r = await call('admin', 'GET', '/api/seva-wall?view=all&search=Ravi');
  check('no priority column value -> medium, no receipt', [r.total, r.rows[0].priority, r.rows[0].receipt_number], [1, 'medium', null]);
  r = await call('admin', 'GET', '/api/seva-wall?view=all&search=Sita');
  check('the priority column is used when given', [r.rows[0].priority, r.rows[0].receipt_number, r.rows[0].honoree_name], ['high', 'B-1', 'Late Ram']);
  check('uploading the same sheet again adds nothing', (await call('admin', 'POST', '/api/seva-wall/bulk', body(false))).added, 0);
  const noPriority = await call('admin', 'POST', '/api/seva-wall/bulk', body(false, ['Name', 'Phone', 'Amount', 'Seva'], [['Plain Row', '9444444444', '2000', 'Mandir']]));
  check('a sheet with no priority column at all works, as medium', noPriority.added, 1);
  check('...and a Mandir row is Mandir', (await call('admin', 'GET', '/api/seva-wall?view=all&search=Plain')).rows[0].kind, 'mandir');

  console.log('\n--- Seva wall calls are tracked like every other call ---');
  const lead = async (phone: string) => (await pool.query(`SELECT id, status, assigned_to, call_attempts, next_follow_up_at, last_outcome FROM leads WHERE phone = $1`, [phone])).rows[0];
  const calls = async (leadId: string) =>
    (await pool.query(`SELECT disposition, connected, user_id, note FROM lead_activities WHERE lead_id = $1 AND kind = 'call' ORDER BY occurred_at, id`, [leadId])).rows;
  const bala = await lead('9000000002');
  check('a donor with no lead gets one, closed and neutral, so it never joins a queue', [bala.status, (await pool.query(`SELECT is_open, is_won, is_lost FROM crm_statuses WHERE slug = 'seva_wall'`)).rows[0]], ['seva_wall', { is_open: false, is_won: false, is_lost: false }]);
  check('...owned by the caller who made the calls', bala.assigned_to, ids.caller);
  const balaCalls = await calls(bala.id);
  const tally = (d: string) => balaCalls.filter((c: any) => c.disposition === d).length;
  check('every answered and not-answered call is in the call log', [tally('seva_wall_answered'), tally('seva_wall_no_answer'), balaCalls.length], [3, 2, 5]);
  check('answered counts as connected, not answered does not', balaCalls.every((c: any) => c.connected === (c.disposition === 'seva_wall_answered')), true);
  check('each is credited to the caller', balaCalls.every((c: any) => c.user_id === ids.caller), true);
  check('and says it came from the Seva wall, with what the donor said',
    [balaCalls.every((c: any) => /^Seva wall \(/.test(c.note)), balaCalls.some((c: any) => /Wants to donate another brick/.test(c.note))], [true, true]);
  check('the attempts are counted on the lead like any call', bala.call_attempts, 5);
  check('...but no retry is booked and the stage is not moved', [bala.next_follow_up_at, bala.status], [null, 'seva_wall']);
  const preLead = await lead('9333333300');
  check('a donor who is already a lead keeps their stage and owner', [preLead.status, preLead.assigned_to], ['attempting', ids.admin]);
  const preCalls = await calls(preLead.id);
  check('...and the calls are added to that lead', preCalls.map((c: any) => c.disposition), ['seva_wall_no_answer', 'seva_wall_no_answer', 'seva_wall_answered']);
  check('the two dispositions are hidden from the calling screen', (await pool.query(`SELECT COUNT(*)::int AS n FROM crm_dispositions WHERE slug LIKE 'seva_wall%' AND active`)).rows[0].n, 0);

  console.log('\n--- donations before the start day are not on the wall ---');
  delete process.env.SEVA_WALL_FROM;
  check('the wall starts on 1 September 2026 unless told otherwise', wallStart(), '2026-09-01');
  process.env.SEVA_WALL_FROM = '2026-08-15';
  r = await call('admin', 'GET', '/api/seva-wall?view=all');
  check('an August donation (1 Aug) is left off every table', r.rows.some((x: any) => x.ref === oldBrick), false);
  check('...while September and later donations stay', r.rows.some((x: any) => x.ref === midSqft) && r.rows.some((x: any) => x.ref === newBrick), true);
  const cutTotal = r.total as number;
  const c = r.counts as Record<string, number>;
  check('the counts agree with the list', c.to_print + c.needs_reprint + c.to_call + c.called + c.sent, cutTotal);
  check('a link already sent to the donor still works', (await getRaw(share)).http, 200);
  check('and so does its picture', (await getRaw(`${share}/image`)).http, 200);
  check('a brick added by hand is not cut off by the start day', (await call('admin', 'GET', '/api/seva-wall?view=all&search=BOOK-77')).total, 1);
  process.env.SEVA_WALL_FROM = '2026-01-01';
  const fullList = await call('admin', 'GET', '/api/seva-wall?view=all');
  check('moving the start day back brings it back, with its history', [fullList.rows.some((x: any) => x.ref === oldBrick), fullList.total - cutTotal], [true, 1]);
  check('nothing was removed to hide it', (await pool.query(`SELECT COUNT(*)::int AS n FROM donations`)).rows[0].n, 8);

  console.log('\n--- nothing was deleted ---');
  check('every step is on record, in order',
    (await pool.query(`SELECT e.action FROM seva_wall_events e JOIN seva_wall_items i ON i.id = e.item_id
                        WHERE i.donation_id = $1 ORDER BY e.id`, [oldBrick])).rows.map((x: any) => x.action),
    ['uploaded', 'replaced', 'called', 'sent_back', 'message', 'message', 'message', 'message', 'message', 'message', 'replaced', 'message', 'whatsapp_sent', 'called', 'sent']);
  check('every donation is still there', (await pool.query(`SELECT COUNT(*)::int AS n FROM donations`)).rows[0].n, 8);

  server.close();
  await pool.end();
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nall passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
