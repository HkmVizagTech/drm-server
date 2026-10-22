// The page a donor opens from the WhatsApp message about their brick, and the
// picture it shows.
//
// WHY THIS EXISTS
// A wa.me link can only carry text, so it cannot attach the picture. But when a
// message contains a link, WhatsApp fetches that page and shows a preview card
// built from its Open Graph tags - a thumbnail of the picture and a title. This
// page is what it fetches. The donor sees the card in the chat, and opens a clean
// page with the full picture and the thank-you.
//
// NO LOGIN, ON PURPOSE - the donor is not a DRM user. The only protection is the
// token in the link, which is 128 random bits and is not the donation id, so it
// cannot be guessed. The page shows the name on the brick and the seva, and
// nothing else about the donor.

import { Router, Request, Response } from 'express';
import { brickByToken } from './sevaWall';

const router = Router();

const KIND: Record<string, string> = { brick: 'Brick seva', square: 'Square foot seva', mandir: 'Mandir nirmana seva' };

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function origin(req: Request): string {
  const fixed = (process.env.PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  if (fixed) return fixed;
  const proto = String(req.get('x-forwarded-proto') ?? req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}

const gone = (res: Response) => res.status(404).type('text/plain').send('This link is not available.');

router.get('/b/:token', async (req, res) => {
  try {
    const brick = await brickByToken(String(req.params.token));
    if (!brick) return gone(res);
    const seva = KIND[brick.kind] ?? 'Seva';
    const title = `Your ${seva} - Hare Krishna Movement Vizag`;
    const message = `Hare Krishna! Thank you${brick.name ? ` ${brick.name}` : ''} for your ${seva}. Here is your brick with the name printed.`;
    const image = `${origin(req)}/b/${req.params.token}/image`;
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(message)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<style>
  body{margin:0;background:#f4f7f3;color:#1c2a1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center}
  main{width:100%;max-width:520px;padding:24px 16px 40px;text-align:center}
  h1{font-size:20px;margin:8px 0 4px}
  p{margin:6px 0 16px;color:#46564a;line-height:1.5}
  img{width:100%;height:auto;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.15);background:#fff}
  small{display:block;margin-top:20px;color:#7a887d}
</style></head>
<body><main>
<h1>Hare Krishna!</h1>
<p>${esc(message)}</p>
<img src="${esc(image)}" alt="Your brick with the name printed">
<small>Hare Krishna Movement, Visakhapatnam</small>
</main></body></html>`);
  } catch (err) {
    console.error('seva-wall public page error:', (err as Error).message);
    res.status(500).type('text/plain').send('Something went wrong. Please try again.');
  }
});

router.get('/b/:token/image', async (req, res) => {
  try {
    const brick = await brickByToken(String(req.params.token));
    const bytes = brick ? await brick.load() : null;
    if (!brick || !bytes) return gone(res);
    res.setHeader('Content-Type', brick.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.send(bytes);
  } catch (err) {
    console.error('seva-wall public image error:', (err as Error).message);
    res.status(500).type('text/plain').send('Something went wrong. Please try again.');
  }
});

export default router;
