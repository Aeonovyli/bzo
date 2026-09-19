# List server -- what's left

What bzo actually supports today is `docs/list-server.md`. This is only the
remainder: one real gap, left open in issue #46's own design discussion and
never picked back up since.

## Admin capabilities beyond revoke

A local admin (`adminGroups`) can revoke any registered key
(`DELETE /api/list-server/keys/:id`), which drops that row from `/list`'s
bzo-servers table the next time it would have reported. Two related things
an admin cannot do:

- **Force-unlist a live row without revoking its key.** Revoking is the only
  lever today, and it also ends that server's ability to report at all --
  there is no "hide this row but leave the registration alone" action.
- **Edit someone else's registered URL.** An admin can only revoke and let
  the operator re-register; there is no in-place edit.

Neither came up as a real need while building this -- they were open
questions in the original design discussion, not requests from an actual
operator. Worth adding if either becomes one.
