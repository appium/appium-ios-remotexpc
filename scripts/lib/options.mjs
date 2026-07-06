/**
 * @param {string} value
 * @param {string} label
 * @returns {number}
 */
export function parsePositiveIntegerOption(value, label) {
  return parseIntegerOption(value, label, (num) => num > 0, 'a positive integer in milliseconds');
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {number}
 */
export function parseNonNegativeIntegerOption(value, label) {
  return parseIntegerOption(value, label, (num) => num >= 0, 'a non-negative integer (0 = unlimited)');
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {number}
 */
export function parsePortOption(value, label) {
  return parseIntegerOption(value, label, (num) => num > 0 && num <= 65535, 'an integer between 1 and 65535');
}

/**
 * @param {string} value
 * @param {string} label
 * @param {(num: number) => boolean} isValid
 * @param {string} expectation
 * @returns {number}
 */
function parseIntegerOption(value, label, isValid, expectation) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || !isValid(num)) {
    throw new Error(`Invalid ${label}: ${value}. Expected ${expectation}.`);
  }
  return num;
}
