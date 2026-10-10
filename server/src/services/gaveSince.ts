// "Have they paid since?" - one rule for every Nearly gave screen, the bell and
// the notifications, so they can never disagree about who still needs a call.
//
// An unfinished attempt counts as settled when:
//   0. that very attempt was paid - the site keeps one record per donation, so
//      a pending payment that completes arrives in DRM under the same id;
// or, at or after the attempt:
//   1. a donation came in from the same mobile number, on either site or in DRM;
//   2. their lead was marked as donated (a caller linked a payment made from
//      another number - "my son paid from his phone");
//   3. a donation came in under the SAME NAME within a day of the attempt -
//      the donor who gave up on one number and paid with another. Names are
//      compared without spaces, dots or case ("K. Ravi Kumar" = "k ravi kumar").
//      A one-word name ("Ramesh") is too common to trust alone, so it also has
//      to be the same amount.

/** Letters only, lower case: the form a name is compared in. */
export const nameKey = (expr: string) => `lower(regexp_replace(COALESCE(${expr}, ''), '[^a-zA-Z]', '', 'g'))`;

/**
 * SQL that is TRUE when the attempt `a` has been paid since. `a` must have
 * external_id, phone, name, amount and attempted_at columns (an abandoned_attempts row).
 */
export function gaveSinceSql(a: string): string {
  return `(
    EXISTS (SELECT 1 FROM donations gx WHERE gx.external_ref = ${a}.external_id)
    OR EXISTS (
      SELECT 1 FROM people gp JOIN donations gd ON gd.person_id = gp.id
       WHERE right(regexp_replace(gp.phone, '\\D', '', 'g'), 10) = ${a}.phone
         AND gd.created_at >= ${a}.attempted_at)
    OR EXISTS (
      SELECT 1 FROM leads gl WHERE gl.phone = ${a}.phone AND gl.converted_at >= ${a}.attempted_at)
    /* THE SAME-NAME CHECK, SPLIT SO EACH HALF CAN USE AN INDEX.

       This was one EXISTS joining donations to people with
         (key(gd.given_name) = key OR key(gp.name) = key)
       inside a one-day window. An OR across two tables cannot use an index, so
       for every abandoned attempt Postgres walked every donation made that
       day - a few hundred - looked each one's donor up and ran a regular
       expression over two names. On the real data that was about fifty
       thousand lookups to settle two hundred people, and ninety-seven per cent
       of the time the Nearly gave list took to open.

       Distributing the OR over two EXISTS is the same condition, and each half
       is now an equality on an expression that has an index
       (idx_donations_given_name_key, idx_people_name_key in schema.sql). The
       first half drops the join to people: donations.person_id is NOT NULL
       with a foreign key, so that join could never remove a row. */
    OR (length(${nameKey(`${a}.name`)}) >= 4 AND (
      EXISTS (
        SELECT 1 FROM donations gd
         WHERE ${nameKey('gd.given_name')} = ${nameKey(`${a}.name`)}
           AND gd.created_at >= ${a}.attempted_at
           AND gd.created_at < ${a}.attempted_at + INTERVAL '1 day'
           AND (position(' ' IN btrim(${a}.name)) > 0 OR gd.amount = ${a}.amount))
      OR EXISTS (
        SELECT 1 FROM people gp JOIN donations gd ON gd.person_id = gp.id
         WHERE ${nameKey('gp.name')} = ${nameKey(`${a}.name`)}
           AND gd.created_at >= ${a}.attempted_at
           AND gd.created_at < ${a}.attempted_at + INTERVAL '1 day'
           AND (position(' ' IN btrim(${a}.name)) > 0 OR gd.amount = ${a}.amount))))
  )`;
}
