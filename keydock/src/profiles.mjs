// Providers are configured by the user. No built-in platform presets.
export const SITE_PROFILES = [];
export function findProfile(origin) { return SITE_PROFILES.find(profile=>profile.origins.includes(origin)) || null; }
