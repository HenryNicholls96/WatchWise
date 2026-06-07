// Shared key for the one-time "just finished onboarding" signal. Set by the onboarding flow on success,
// read-and-cleared once by the discovery page's TasteTunedBanner. Kept in one place so the two never drift.
export const JUST_ONBOARDED_KEY = 'ww:just-onboarded'
