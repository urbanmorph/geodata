// Fill a page template's <!-- NAME --> placeholders in one pass. Values go in literally
// (a function replacer, so "$&" or "$'" in catalogue or community text can't splice the
// template), every occurrence is filled, a filled value is never scanned again, and a
// placeholder with no value is left as it is.
export function fillTemplate(tmpl, values) {
  return tmpl.replace(/<!-- ([A-Z0-9_]+) -->/g, (m, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : m);
}
