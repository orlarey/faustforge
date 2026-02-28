/**
 * Purpose: Provide shared text rendering helpers for view modules.
 * How: Exports small pure utilities used by multiple code and DOT views.
 */

/**
 * Purpose: Sanitize plain text before HTML insertion.
 * How: Replaces reserved characters with HTML entities.
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Purpose: Build a line-number gutter as a newline-separated string.
 * How: Generates numbers from 1..N and joins them in display order.
 */
export function generateLineNumbers(lineCount) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(i);
  }
  return lines.join('\n');
}
