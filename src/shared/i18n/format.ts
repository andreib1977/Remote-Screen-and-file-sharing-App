/**
 * Interpolation for translated strings: `format('{count} active', { count: 3 })`.
 *
 * Unknown placeholders are left alone rather than replaced with "undefined", so a typo in a
 * translation is visible in the UI instead of silently printing nothing.
 */
export function format(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}
