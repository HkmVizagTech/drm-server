// What counts as a REALLY ACTIVE recurring donation - the one definition the dashboard card, the
// Recurring screen's Active tab and its download all share, so a tile and the list behind it cannot
// disagree.
//
// A subscription is really active when money is actually coming in, not merely when a row says
// "active":
//
//   - entered by hand in DRM (no id from a site): active if DRM says active - somebody typed it in;
//   - from a site: the site reports it active, or (main site only) its latest charge went through
//     ('completed' is how the main site reports a paid charge; on annadan it means the subscription
//     ENDED), AND a charge has gone through lately - within a month
//     (a quarter / a year for those frequencies, with a few days' grace). One that never charged is
//     counted only while it is still that new.
//
// 'pending' (set up, nothing charged), 'failed' and 'cancelled' are never active. A row last
// confirmed long ago, or never confirmed by the site since DRM began keeping this, is "not charging"
// until the next refresh says otherwise (services/subscriptionRefresh.ts).

/** SQL for "really active" on a subscriptions row aliased `a` (default `s`). */
export const REALLY_ACTIVE = (a = 's') => `(
  ${a}.status = 'active' AND (
    (${a}.external_ref IS NULL)
    -- Razorpay's own live status, when the main site passed it on, is the truth.
    OR COALESCE(${a}.live_status, '') = 'active'
    OR (${a}.live_status IS NULL AND
      -- 'completed' is a paid charge on the main site, but a subscription that has ENDED on annadan.
      (${a}.site_status = 'active' OR (${a}.source_site = 'hkmv' AND ${a}.site_status = 'completed'))
      AND COALESCE(${a}.last_charged_at, ${a}.start_date::timestamptz) >
          NOW() - (CASE ${a}.frequency
                     WHEN 'yearly'    THEN INTERVAL '380 days'
                     WHEN 'quarterly' THEN INTERVAL '100 days'
                     ELSE INTERVAL '35 days' END)
    )
  )
)`;

/** Marked active, but not really: pending, failed, never confirmed, or no charge lately. */
export const NOT_CHARGING = (a = 's') => `(${a}.status = 'active' AND NOT ${REALLY_ACTIVE(a)})`;
