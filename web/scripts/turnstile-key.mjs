// The Turnstile site key /preview's captcha uses, baked in at build.
//
// Local, test and pull-request builds use Cloudflare's always-pass test key.
// A deploy build in CI (COMMUNITY_FROM=remote, set by .github/workflows/ci.yml
// on main, dispatch and schedule) must carry the real key: with the test key
// the captcha passes in the browser and every submission then fails the
// server's check, which nothing at build time would show.

export const TEST_SITEKEY = '1x00000000000000000000AA';

/** @param {Record<string, string | undefined>} env */
export function turnstileSiteKey(env) {
  const key = env.TURNSTILE_SITEKEY;
  const deploy = Boolean(env.CI) && env.COMMUNITY_FROM === 'remote';
  if (deploy && (!key || key === TEST_SITEKEY)) {
    throw new Error('TURNSTILE_SITEKEY: a deploy build needs the real site key (set the TURNSTILE_SITEKEY secret)');
  }
  return key || TEST_SITEKEY;
}
