// classify.js — option lists for sector/region dropdowns.

// The 11 official GICS sectors. GICS is an equity classification standard, so
// it has nothing for bonds or private alts — those get a few app-specific
// additions already in use elsewhere in the data (Fixed Income, Private
// Equity, Private Credit) rather than being forced into a GICS bucket that
// doesn't fit.
export const GICS_SECTORS = [
  'Energy', 'Materials', 'Industrials', 'Consumer Discretionary', 'Consumer Staples',
  'Health Care', 'Financials', 'Information Technology', 'Communication Services',
  'Utilities', 'Real Estate',
];
export const SECTOR_OPTIONS = [...GICS_SECTORS, 'Fixed Income', 'Private Equity', 'Private Credit', 'Diversified'];

// Sovereign/market countries an equity or fund holding is realistically
// domiciled or listed in. Plus a few multi-region labels already used for a
// diversified fund with no per-country breakdown entered.
export const COUNTRIES = [
  'Canada', 'United States', 'United Kingdom', 'Ireland', 'France', 'Germany', 'Switzerland',
  'Netherlands', 'Belgium', 'Luxembourg', 'Spain', 'Italy', 'Portugal', 'Austria', 'Sweden',
  'Norway', 'Denmark', 'Finland', 'Iceland', 'Poland', 'Czech Republic', 'Hungary', 'Greece',
  'Turkey', 'Israel', 'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'South Africa',
  'Japan', 'China', 'Hong Kong', 'Taiwan', 'South Korea', 'Singapore', 'India', 'Indonesia',
  'Malaysia', 'Thailand', 'Philippines', 'Vietnam', 'Australia', 'New Zealand',
  'Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia', 'Peru',
];
export const REGION_OPTIONS = [
  ...COUNTRIES, 'International', 'Global', 'Emerging Markets', 'Developed Markets (ex-North America)',
];
