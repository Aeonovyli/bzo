# List server -- what's left

What bzo supports today is `docs/list-server.md` -- including the two-pane
list and upstream's filter language (#147) and the uptime a `boot` report
gives (#106). This is the remainder: the rest of what #147 wondered a list
could show, and one gap left open in #46's design discussion. Upstream
references are paths under `$HOME/bzflag/`.

## Watch: what is left of it

Built, and described in `docs/proxy.md` under "Watching a server this instance
does not proxy". What that section does not settle:

**Who may, eventually.** It is limited to a signed-in admin of this instance
while it is being tried out. The question the limit defers is whether an
ordinary signed-in player should be able to watch a stranger's server from
here -- which is really a question about how much traffic an operator wants
this instance sending to servers they have no relationship with.

Chat needed nothing, which is worth recording so it is not reopened. bzfs
puts no verification check on `MsgMessage`, but servers configure it: Planet
MoFo relays a watcher's chat and a server set to withhold messaging from
unauthenticated observers does not, while watching works on both. bzo neither
grants nor withholds it, and a target that refuses says so itself -- the
refusal arrives as an ordinary server message and is already shown. Nothing
to build.

**A row still does not say whether watching is worth it.** The pane says it
now -- a server offering no observer slots shows no Observers line -- but the
Watch link is offered anyway, and the row itself gives no sign before you pick
it. None currently refuse, which is why this has not bitten.

## Player counts, rosters, and who is where

Counts are built: the readout pane shows per-team counts and maxima, the score
and time limits and the shake conditions, for a bzfs row off its ping packet
and for a bzo row off its report. None of it joins anything.

Player *names and scores* are not. They need a join, which every operator sees
as a `bzo-*` observer arriving and leaving, and `/playerlist` is permission-
gated so a watcher cannot ask for them either. Presence has to come from the
connection itself. These two want separating in any build: one is polite, the
other is visible.

**Cross-server presence is a new kind of data**, and the plan should say so
before collecting it. "Who is online and where" means the list server
continuously knows where each player is. Upstream's list server does not do
this; bzstats builds it by scraping. If bzo wants it, it wants an opt-out and
a sentence explaining itself, not a cache that happened to grow.

## JSON or a database

The store holds three records of eight fields plus the *latest* status, and
nothing historical (`server/list-server.cjs`). JSON is fine for that
indefinitely.

What it cannot grow into is history: scores over time, availability over a
window, a presence trail. That is append-only time series and it is the only
requirement here that forces the question. So the decision is not JSON versus
SQLite in the abstract -- it is whether history is wanted.

Uptime already showed where the line falls. "Up since" is one timestamp on a
record JSON holds without complaint, and it is built. "Up 99% of the last
week" is the same question asked of a session log, and nothing here keeps one:
`failCount` and `lastChecked` from `validateListServerKey` are the crude
version, a count and a single most-recent time, which cannot answer it.

## Admin capabilities beyond revoke

A local admin (`adminGroups`) can revoke any registered key
(`DELETE /api/list-server/keys/:id`), which drops that row from `/list`'s
bzo-servers table the next time it would have reported. Two related things an
admin cannot do:

- **Force-unlist a live row without revoking its key.** Revoking is the only
  lever today, and it also ends that server's ability to report at all --
  there is no "hide this row but leave the registration alone" action.
- **Edit someone else's registered URL.** An admin can only revoke and let the
  operator re-register; there is no in-place edit.

Neither came up as a real need while building this -- they were open questions
in the original design discussion, not requests from an actual operator.
Worth adding if either becomes one.

## Order of work

1. **Presence and history**, behind the database decision, which availability-
   over-a-window is the test for.

Watch is built (above), ahead of this order rather than in it: it was wanted
for testing, and it turned out to need no new policy -- only the map
importer's own rule and a narrower gate.
