// The moderation policy for a newly added record, in one place.
//
// Moderation exists to review CONTRIBUTOR (edit-link) input — the crowd — not the
// owner's own data. So the owner (admin) always publishes immediately; a
// contributor goes pending only when the map is moderated. This is what stops the
// owner from having to approve their own bulk imports and captures.
export function recordStatusFor(isAdmin: boolean, moderation: number | boolean): 'published' | 'pending' {
  if (isAdmin) return 'published';
  return moderation ? 'pending' : 'published';
}
