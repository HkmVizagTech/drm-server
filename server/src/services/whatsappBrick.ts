// Tells a devotee, on WhatsApp, that the brick they added is approved - with the brick's picture and
// the donor's name and number, so they can share it with the donor themselves.
//
// It is a business-started message, so it must be an approved template: a picture in the header and
// three values in the body. The template's name is FLAXXA_BRICK_TEMPLATE; without it nothing is sent
// (the brick is still approved, and the devotee sees it in their table).
//
//   body {{1}}  the honoree's name (printed on the brick)
//   body {{2}}  the donor's name
//   body {{3}}  the donor's phone number
//
// Same Flaxxa account as the sign-in code (FLAXXA_TOKEN). Flaxxa answers HTTP 200 even when Meta
// rejects a message, so only a message id counts as sent.

export interface BrickMessage {
  devoteePhone: string; // 10 digits
  honoree: string;
  donorName: string;
  donorPhone: string;
  image: { bytes: Buffer; mime: string };
}
export type BrickResult = { ok: true } | { ok: false; reason: 'not_configured' | 'rejected' | 'failed'; detail?: string };
export type BrickSender = (m: BrickMessage) => Promise<BrickResult>;

const flaxxaSender: BrickSender = async (m) => {
  const token = process.env.FLAXXA_TOKEN;
  const template = process.env.FLAXXA_BRICK_TEMPLATE;
  if (!token || !template) return { ok: false, reason: 'not_configured' };
  try {
    const form = new FormData();
    form.append('token', token);
    form.append('phone', `91${m.devoteePhone}`);
    form.append('template_name', template);
    form.append('template_language', 'en');
    form.append(
      'components',
      JSON.stringify([
        {
          type: 'body',
          parameters: [m.honoree, m.donorName, m.donorPhone].map((text) => ({ type: 'text', text: text || '-' })),
        },
      ])
    );
    const ext = m.image.mime === 'image/png' ? 'png' : m.image.mime === 'image/webp' ? 'webp' : 'jpg';
    form.append('header_attachment', new Blob([new Uint8Array(m.image.bytes)], { type: m.image.mime }), `brick.${ext}`);
    const res = await fetch('https://wapi.flaxxa.com/api/v1/sendtemplatemessage_withattachment', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const body = (await res.json().catch(() => ({}))) as { message_wamid?: string; wamid?: string };
    if (!body.message_wamid && !body.wamid) {
      return { ok: false, reason: 'rejected', detail: JSON.stringify(body).slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'failed', detail: (e as Error).message };
  }
};

let sender: BrickSender = flaxxaSender;

/** Tests swap this so no real message is ever sent. */
export function setBrickSender(fn: BrickSender | null) {
  sender = fn ?? flaxxaSender;
}

export const sendBrickToDevotee: BrickSender = (m) => sender(m);
