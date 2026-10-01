# DRM design system

What to reach for, and what not to write by hand. The short version: if you are
typing a colour, a radius, a shadow or a button's padding into a page file, the
thing you want already exists.

## Why this document exists

An audit of this client counted, across 26 pages:

- 14 distinct hand-rolled button class strings, in 5 paddings, with 3 hover
  treatments and 4 disabled opacities
- 3 different table-header treatments across 24 `<thead>` elements
- 7 hand-rolled modal overlays with 4 different backdrops, beside a shared
  `Modal` that already existed
- the same error-banner string copied 18 times
- 7 corner radii and 4 shadows, with no scale behind either
- 2 `inputClass` constants, one shadowing the other
- 4 different filter-row layouts

None of that was carelessness. The shared pieces were harder to use than
writing a one-off: only 4 of 14 colour tokens were mapped into Tailwind, so
using the palette meant typing `bg-[var(--surface)]`, and the "Button" was an
exported string that could not take a variant, a size, an icon or a loading
state. People wrote their own because their own was easier.

Both of those are fixed. This file says what to use instead.

## Colour

Never write a hex value, a `slate-*`/`gray-*` class, or `bg-[var(--token)]` in
a page. Every token is a real utility:

| Use | Class |
| --- | --- |
| Page background | `bg-page` |
| A card or panel | `bg-surface` |
| A table header, toolbar, or well | `bg-sunken` |
| Body text | `text-ink` |
| Secondary text | `text-ink-soft` |
| Labels, captions, metadata | `text-ink-muted` |
| Placeholders, disabled | `text-ink-faint` |
| Hairlines | `border-line-soft` |
| Input and button borders | `border-line-strong` |
| Brand, at nine steps | `bg-brand-50` … `bg-brand-900`, `text-brand-700` |
| Status | `text-good`, `text-warn`, `text-danger`, `text-info` and their `-wash` fills |

The brand ramp exists so hover and pressed states are steps on a scale rather
than opacity tricks. `hover:opacity-90` is not a hover state; `hover:bg-brand-700`
is.

## Shape and depth

| Use | Class |
| --- | --- |
| Buttons, inputs, selects, chips | `rounded-control` |
| Cards, tables, alerts | `rounded-card` |
| Dialogs, large panels | `rounded-panel` |
| Pills and badges | `rounded-pill` |
| Resting card | `shadow-card` |
| Hovered or lifted card | `shadow-raised` |
| Dropdown, popover | `shadow-float` |
| Dialog | `shadow-dialog` |

Do not use `rounded-lg`, `rounded-xl`, `shadow-sm`, `shadow-md` or `shadow-xl`
in a page. They are not wrong, they are just not the scale, and mixing the two
is how seven radii happened.

## Components

Everything below is exported from `@/components/ui` unless noted.

### Actions

```tsx
<Button>Save</Button>                                   // primary, md
<Button variant="secondary" icon="refresh">Refresh</Button>
<Button variant="ghost" size="sm">Cancel</Button>
<Button variant="dangerSoft" icon="trash">Delete</Button>
<Button loading={saving}>Save</Button>                  // spinner, click blocked
<IconButton name="edit" label="Edit this lead" />       // label is required
<LinkButton href="/leads" icon="arrowLeft">Back</LinkButton>
```

Variants: `primary`, `secondary`, `ghost`, `danger`, `dangerSoft`, `whatsapp`.
Sizes: `xs`, `sm`, `md`, `lg`.

`buttonPrimary` / `buttonSecondary` still exist as class strings and are
generated from the same source, so old markup keeps working. New code uses the
component — a string cannot carry a loading state, which is how double-submits
happen.

Never use a primary button to mean "this filter is on". That is
`SegmentedControl` or `Tabs`.

### Inputs

```tsx
<Field label="Amount" hint="Leave blank if unknown" htmlFor="amt">
  <Input id="amt" value={v} onChange={…} />
</Field>

<SearchInput value={q} onChange={setQ} placeholder="Name or phone…" />
<Select value={status} onChange={setStatus} options={…} ariaLabel="Status" />
<Checkbox checked={on} onChange={setOn} label="Include settled" />
<Toggle on={active} onChange={setActive} label="Account can sign in" />
<Textarea value={notes} onChange={…} />
```

`inputClass` and `textareaClass` remain for places that need the raw string.

### Layout

```tsx
<PageHeader eyebrow="Calling" title="Nearly gave" subtitle="…" actions={…} />

<Toolbar onClear={reset} activeCount={n}>      // the filter row, one shape
  <Field label="From" className="w-40"><Input type="date" … /></Field>
  …
</Toolbar>

<Card>…</Card>
<Card interactive>…</Card>                      // lifts on hover; for a card that links
<CardHeader title="Recent donations" icon="rupee" action={…} />
<StatTile label="Raised today" value="₹12,400" icon="rupee" accent="brand" />
```

### Tables

```tsx
<TableShell>
  <Thead>
    <Th>Name</Th>
    <Th align="right">Amount</Th>
    <Th sort={{ active: sort === "date", direction: "desc", onSort: () => setSort("date") }}>
      Date
    </Th>
  </Thead>
  {loading ? <SkeletonRows rows={8} cols={5} /> : (
    <Tbody>
      {rows.map(r => <tr key={r.id}><Td>{r.name}</Td>…</tr>)}
    </Tbody>
  )}
</TableShell>
```

`Thead` and `Tbody` carry the header fill, the dividers and the row hover, so a
table cannot be built with the wrong one. Never write `<thead className="bg-slate-50/80">`.

A `TableShell` must not be nested inside a `<Card padded={false}>` — both draw a
bordered, shadowed surface, and stacking them makes a double edge.

### Feedback

```tsx
<Alert tone="danger">{error}</Alert>
<Alert tone="warn" title="Two sites are out of date">…</Alert>
<Alert tone="good" onDismiss={() => setMsg(null)}>Receipt sent.</Alert>

<EmptyState icon="inbox" title="Nothing to call" message="…" action={<Button …/>} />
<Spinner />                                     // from @/components/icons
<Skeleton className="h-10 w-full" />            // non-table loading
<Badge tone="good" dot>Converted</Badge>
<StatusBadge status={row.status} />
```

Tones: `info`, `good`, `warn`, `danger`. There is no reason to hand-write a
coloured box again.

### Navigation and overlays

```tsx
<Tabs items={[{ key: "open", label: "Open", count: 12 }]} value={tab} onChange={setTab} />
<Tabs … variant="pill" />
<SegmentedControl options={[{ value: "mine", label: "Mine" }, …]} value={v} onChange={…} />
<DropdownMenu trigger={({ toggle }) => <Button onClick={toggle}>…</Button>} items={…} />
<Modal title="Add a lead" onClose={close} footer={<Button>Save</Button>}>…</Modal>
```

`Modal` traps focus, returns it on close, locks body scroll and closes on
Escape but not on a backdrop click — a mis-click while filling a form should
not discard it. Do not hand-roll an overlay.

### Downloads

```tsx
<ExportButton
  path="/crm/leads/export"      // no extension; the component adds .csv / .xlsx
  params={filterParams()}        // the SAME object the list request used
  filename="leads"
/>
```

From `@/components/export-button`. It offers Excel or CSV from one button and
strips `page`/`limit` before sending, so the file is the whole filtered set
rather than the page on screen.

The rule it enforces: **a download contains exactly what the filters on screen
select.** Build the params once, in a `filterParams()` callback, and pass the
same value to both the list fetch and the export. Never rebuild them — they
drift, and someone acts on the wrong file.

### Icons

```tsx
import { Icon } from "@/components/icons";
<Icon name="download" size={16} />
```

One set, one stroke weight, `currentColor`. Never paste raw `<svg>` into a
page, and never use `→` or `←` as an arrow — that is `<Icon name="arrowRight" />`.

## Dates

Every date shown is IST, always, regardless of the viewer's device. Use the
helpers in `@/lib/format` — `shortDate`, `dateTime`, `relativeDate`,
`dueLabel`, `istToday`, `istDateKey`, `istInstant`, `istInputToISO` — and never
call `toLocaleDateString()` directly. A bare `new Date("2026-10-15")` parses as
UTC midnight, which is 05:30 IST, and that is how a callback lands on the wrong
day.

## Checklist for a new screen

1. `PageHeader` with an `eyebrow` naming the section.
2. Filters in one `Toolbar`, each in a `Field`.
3. An `ExportButton` in the header if the screen lists records.
4. `TableShell` + `Thead` + `Tbody`, or `Card` for non-tabular content.
5. `SkeletonRows` or `Skeleton` while loading — never a bare "Loading…".
6. `EmptyState` when there is nothing, with an action if there is one to offer.
7. `Alert` for errors. One at the top, not a sentence in grey text.
