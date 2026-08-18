// Public Turnstile sitekey for the collect widget (managed mode). Overridable
// at build via VITE_TURNSTILE_SITEKEY; the default is the live public key.
export const TURNSTILE_SITEKEY =
  ((import.meta.env?.VITE_TURNSTILE_SITEKEY as string) || '').trim() || '0x4AAAAAAEUVQ4gS3xN4W2l1';
