// Sends a one-time code on WhatsApp, through Flaxxa and the approved "otp" template - the same
// path the campaigner server uses for its OTP login.
//
// Authentication templates: Meta rewrites the copy-code button into a URL button at approval, so
// the code is supplied TWICE - as the body variable and as the button's URL parameter. Flaxxa
// answers HTTP 200 even when Meta rejects the message, so the ONLY reliable success signal is a
// non-null message id.
//
// Settings: FLAXXA_TOKEN (required), FLAXXA_OTP_TEMPLATE (default "otp").

export type OtpSender = (phone10: string, code: string) => Promise<void>;

const flaxxaSender: OtpSender = async (phone10, code) => {
  const token = process.env.FLAXXA_TOKEN;
  if (!token) throw new Error('FLAXXA_TOKEN is not set, so no WhatsApp can be sent.');
  const res = await fetch('https://wapi.flaxxa.com/api/v1/sendtemplatemessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      token,
      phone: `91${phone10}`,
      template_name: process.env.FLAXXA_OTP_TEMPLATE || 'otp',
      template_language: 'en',
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { message_wamid?: string; wamid?: string };
  if (!body.message_wamid && !body.wamid) {
    console.error(`WhatsApp OTP rejected for ${phone10}:`, JSON.stringify(body).slice(0, 300));
    throw new Error('WhatsApp did not accept the OTP message');
  }
};

let sender: OtpSender = flaxxaSender;

/** Tests swap this so no real message is ever sent. */
export function setOtpSender(fn: OtpSender | null) {
  sender = fn ?? flaxxaSender;
}

export const sendOtp: OtpSender = (phone10, code) => sender(phone10, code);
