// Which calls, and which money, were Nearly gave work - for the calling
// overview's split between Nearly gave and every other call, and the
// "Kind of call" filter on My calls.
//
// A NEARLY GAVE CALL is a call to someone who started a donation on one of the
// sites and did not finish it, in the 30 days before the call. (30 days
// because that is how far back the Nearly gave list looks.) Unfinished
// donations on the main site's /donations page do not count: they are never on
// the Nearly gave list either.
//
// NEARLY GAVE MONEY is a caller's credited money from someone that same caller
// rang as a Nearly gave call in the 30 days before the money arrived.
//
// Everything else is "other": calls to donors, uploaded lists, call-backs, and
// the money that came from them.

import { FROM_DONATIONS_PAGE } from '../routes/crmLists';

export const NEARLY_GAVE_DAYS = 30;

const digits10 = (expr: string) => `right(regexp_replace(COALESCE(${expr}, ''), '\\D', '', 'g'), 10)`;

/**
 * TRUE when the call `a` (a lead_activities row: lead_id, occurred_at) was a
 * Nearly gave call. Two EXISTS - one per number on the lead - so each can use
 * the index on abandoned_attempts(phone).
 */
export const NEARLY_GAVE_CALL = (a: string) => {
  const attempt = (number: string) => `EXISTS (
    SELECT 1 FROM leads ngl JOIN abandoned_attempts nga ON nga.phone = ${number}
     WHERE ngl.id = ${a}.lead_id
       AND nga.attempted_at <= ${a}.occurred_at
       AND nga.attempted_at > ${a}.occurred_at - INTERVAL '${NEARLY_GAVE_DAYS} days'
       AND NOT ${FROM_DONATIONS_PAGE('nga')})`;
  return `(${attempt('ngl.phone')} OR ${attempt(digits10('ngl.alt_phone'))})`;
};

/** The lead a credit `c` (caller_credits) is about: its own, its QR share's, or its donor's. */
const CREDIT_LEAD = `COALESCE(
  c.lead_id,
  (SELECT qs.lead_id FROM qr_shares qs WHERE qs.id = c.share_id),
  (SELECT cl.id FROM people cp JOIN leads cl ON cl.phone = ${digits10('cp.phone')} WHERE cp.id = c.person_id LIMIT 1))`;

/** TRUE when the credit `c` came from that caller's own Nearly gave call. */
export const NEARLY_GAVE_CREDIT = `EXISTS (
  SELECT 1 FROM lead_activities ngc
   WHERE ngc.kind = 'call' AND ngc.user_id = c.user_id
     AND ngc.lead_id = ${CREDIT_LEAD}
     -- An hour's grace: a QR paid while the donor is still on the line
     -- lands before the caller has saved the call.
     AND ngc.occurred_at <= c.occurred_at + INTERVAL '1 hour'
     AND ngc.occurred_at > c.occurred_at - INTERVAL '${NEARLY_GAVE_DAYS} days'
     AND ${NEARLY_GAVE_CALL('ngc')})`;
