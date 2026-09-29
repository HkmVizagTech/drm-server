# WhatsApp in DRM — where it earns its place, and what to design

Written to be read before any template is drafted. Nothing here is built yet.

---

## 1. The one rule that decides every template

Meta puts every template in one of three categories, and the category decides
both the price and whether it gets approved at all. The dividing line is
simpler than it looks:

> **Utility** = no promotional or persuasive intent, and specific to something
> the person already did.
> **Marketing** = anything else — including *anything that asks for money*.

Meta's own wording is that a utility template "should not promote, recommend,
upsell, or cross-sell products; include offers; or attempt to secure renewals."
A donation appeal is a request for money, so **every appeal is Marketing, no
matter how it is worded.** Trying to disguise one as a receipt is the single
most common reason temple templates get rejected, and repeated attempts get the
number's quality rating knocked down.

What this means in practice for us:

| We want to send | Category | Why |
|---|---|---|
| The 80G receipt after a donation | Utility | Confirms a transaction they made |
| Prasadam dispatched / delivered | Utility | Fulfilment of something they bought |
| "Your payment didn't complete" | Utility | About a transaction they started |
| "We'll call you on Tuesday at 4" | Utility | Confirms something they asked for |
| Subscription card failed | Utility | Account alert |
| "You said you'd donate at Govardhan Puja — here's the link" | **Marketing** | Asks for money |
| Festival appeal to a segment | **Marketing** | Asks for money |
| Lapsed-donor re-engagement | **Marketing** | Asks for money |

Pricing moved to **per-message** in July 2025 (the old per-conversation model is
gone). Marketing costs meaningfully more than Utility per message in India, and
the gap is the reason the next section matters so much.

---

## 2. The lever that changes the economics: the 24-hour window

When a **donor messages us first**, a 24-hour customer service window opens. In
that window:

- we can send **free-form messages** — no template, no approval, no waiting
- **non-template messages are free**
- **utility templates are also free** inside the window

For a calling operation this is enormous. The natural flow becomes:

> Caller: *"…I'll send the link on WhatsApp — just reply with anything to this
> number so it reaches you properly."*
> Donor sends "ok" → window opens → DRM sends the payment link as a free-form
> message, instantly, at no cost, with no template to get approved.

**This should be the default path for everything conversational**, with
templates as the fallback for donors who never reply. It also means the single
highest-value piece of work is not a template at all — it is *receiving*
messages (§5).

---

## 3. What already exists — do not rebuild

| Message | Where it lives | Provider |
|---|---|---|
| Receipt + 80G PDF | `paymentCompletion.service.js` (HKMV), `whatsapp.service.js` (annadan) | Gupshup (HKMV, with Flaxxa rollback), Flaxxa (annadan) |
| Pending payment nudge, ~6 min | `pendingReminder.controller.js` (annadan), Gupshup pending template (HKMV) | both |
| Prasadam dispatched | `sendPrasadamDispatchWhatsapp` | Flaxxa |
| Birthday / anniversary appeal | `birthday_wish_donation_ask`, `anniversary_wish_donation_ask` | Flaxxa |

DRM must **not** mint its own receipts or duplicate these — it already proxies
offline donations to whichever site issues the receipt, and the same principle
applies here.

### Which number DRM should send from

**Send from the number the donor already knows**: HKMV's Gupshup number for
main-site donors, annadan's Flaxxa number for annadan donors. DRM already
records `source_site` on every person, so it can route per donor.

A third "DRM number" would put the temple in three separate WhatsApp threads
with the same person, split the quality rating three ways, and mean a donor who
replies to a call lands in a thread that has none of their receipts in it.

Practically this means the DRM WhatsApp service is a thin router with the same
two-provider shape `paymentCompletion.service.js` already has.

---

## 4. Where WhatsApp genuinely helps in DRM — ranked

Ranked by value per unit of work, not by how interesting they are.

### Tier 1 — build first

**1. Post-call payment link.** The caller ends a good call, taps one button,
and the donor gets the link while the conversation is still fresh. Today they
are told "search for our website", and most don't. Inside the 24h window this
is free-form and free; outside it, one Marketing template.

**2. Reminder nudge to the donor.** The reminders feature just built alerts the
*caller*. The other half is nudging the *donor* at the moment they themselves
named — "you mentioned Govardhan Puja". Marketing category, but the response
rate on a promise the donor made is unlike anything in a broadcast.

**3. Callback confirmation.** "We'll ring you Tuesday around 4pm." Utility,
cheap, and it measurably reduces unanswered callbacks because the donor is
expecting the call. Fires off the follow-up date the caller sets.

### Tier 2 — clear value, slightly more work

**4. Prasadam delivered.** Dispatch already has a template; delivery doesn't.
Closes the loop on 1,611 pending deliveries and cuts "did it arrive?" calls.
Utility.

**5. Abandoned-donation recovery at 24h and 72h.** Both sites nudge at ~6
minutes. Nobody follows up after that, and DRM now has the abandoned list.
Marketing.

**6. Annual 80G statement.** One message in April with the year's total and a
consolidated receipt. Utility, genuinely wanted, and it seeds the next year's
giving without asking for anything.

### Tier 3 — worth doing once the above is running

**7. Segment appeals** (festival, tagged lists) — Marketing; should be
rate-limited and respect `do_not_call`.
**8. Subscription failure alerts** — Utility; probably belongs on the sites.
**9. Caller's daily digest** — internal, to staff, not donors.

### Deliberately NOT recommended

- WhatsApp instead of a call. The calling module exists because a conversation
  converts several times better than a message. WhatsApp supports the call; it
  does not replace it.
- Any appeal to someone marked `do_not_call`. That flag must gate WhatsApp
  exactly as it gates the dialler — it is the same consent.

---

## 5. The highest-leverage piece: receiving messages

Neither site currently handles **inbound** WhatsApp. Adding it unlocks more
than any single template:

- it opens the free 24-hour window, which makes most outbound messaging free
- a donor replying "send the link" lands on their lead in DRM, so the caller
  sees it instead of it disappearing into a phone nobody watches
- missed calls and replies become leads automatically
- "STOP" can set `do_not_call` by itself, which is both courteous and the
  correct handling of an opt-out

Shape: one webhook endpoint per provider → match on phone (last 10 digits, the
same identity rule everything else in DRM uses) → append to `lead_activities`
as `kind='whatsapp'` → open the 24h window flag on the lead.

I'd suggest this is built *with* Tier 1 rather than after it.

---

## 6. Templates to design, with the variables each needs

Design these in this order. Body variables are numbered as Meta expects
(`{{1}}`, `{{2}}`…). Keep every one of them to a **single line each** — Meta
rejects templates whose variables could swallow a whole paragraph.

### A. `drm_payment_link_after_call` — **Marketing**
> Hare Krishna {{1}}, thank you for speaking with us just now. Here is the link
> to complete your {{2}} seva of ₹{{3}}: {{4}}
> Hare Krishna Movement, Visakhapatnam

`{{1}}` donor name · `{{2}}` seva name · `{{3}}` amount · `{{4}}` short link
Button: "Donate" (URL). Header: temple image.

### B. `drm_promise_reminder` — **Marketing**
> Hare Krishna {{1}}, you had kindly mentioned you would like to offer your
> seva at {{2}}. Whenever you are ready: {{3}}
> Hare Krishna Movement, Visakhapatnam

`{{1}}` name · `{{2}}` occasion · `{{3}}` link
Note: no amount in the body — quoting back a figure they mentioned casually
reads as pressure, and it is the commonest reason these get reported.

### C. `drm_callback_confirmation` — **Utility**
> Hare Krishna {{1}}, this is to confirm that {{2}} from Hare Krishna Movement
> Visakhapatnam will call you on {{3}}.

`{{1}}` name · `{{2}}` caller name · `{{3}}` date and time
No link, no amount, nothing promotional — that is what keeps it Utility.

### D. `drm_prasadam_delivered` — **Utility**
> Hare Krishna {{1}}, your Maha Prasadam has been delivered on {{2}}. We pray
> it brings all auspiciousness to your home.

`{{1}}` name · `{{2}}` delivery date

### E. `drm_donation_incomplete_24h` — **Marketing**
> Hare Krishna {{1}}, your offering of ₹{{2}} towards {{3}} did not complete.
> If you would still like to proceed: {{4}}

`{{1}}` name · `{{2}}` amount · `{{3}}` seva · `{{4}}` link

### F. `drm_annual_80g_statement` — **Utility**
> Hare Krishna {{1}}, your consolidated donation statement for FY {{2}} is
> attached. Total offered: ₹{{3}} across {{4}} donations.

`{{1}}` name · `{{2}}` financial year · `{{3}}` total · `{{4}}` count
Header: document (the PDF).

### Three things that will get these rejected

1. **Mixing** — a delivery confirmation that also asks for a donation is
   Marketing, and usually rejected outright rather than re-categorised.
2. **A variable at the very start or very end** of the body. Meta rejects this.
3. **Vague bodies** — a template that is mostly variables reads as unclear
   content and gets refused.

Also worth knowing: Meta **re-categorises** templates after approval. A Utility
template that starts carrying persuasive content silently becomes Marketing and
the price changes without warning, so keep C, D and F strictly clean.

---

## 7. What I need from you before building

1. **Which provider for DRM's sending** — my recommendation is to route per
   donor (Gupshup for HKMV donors, Flaxxa for annadan donors) using the
   existing services, and add nothing new.
2. **Whether inbound is in scope** — it is the difference between "free and
   conversational" and "paid and one-way", so I'd argue strongly for yes.
3. **The templates above, submitted and approved**, with their ids sent to me.
   Gupshup takes a template **id**, Flaxxa takes a **name**; both are needed if
   we route per donor.
4. **A short link domain**, if you want the payment links branded rather than
   raw site URLs.

Once templates A, C and the inbound webhook exist, the calling module gets
materially better in a way callers will feel on the first shift.

---

*Sources for the Meta rules quoted above:*
- [Pricing on the WhatsApp Business Platform — Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [Template categorization — Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
- [Send Template Messages — Gupshup docs](https://docs.gupshup.io/docs/send-template-messages)
