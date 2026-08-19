// Derive a stable field key from a human label (keys are immutable once a
// record exists; the builder generates them from the label at add time).
// Matches the meta-schema's KEY_RE: /^[a-z][a-z0-9_]*$/, and is made unique
// against keys already in the form.

export function deriveKey(label: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  let base = (label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // non-alphanumeric → underscore
    .replace(/_+/g, '_')         // collapse repeats
    .replace(/^_+|_+$/g, '');    // trim leading/trailing
  if (!base) base = 'field';
  if (!/^[a-z]/.test(base)) base = `f_${base}`;

  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}
