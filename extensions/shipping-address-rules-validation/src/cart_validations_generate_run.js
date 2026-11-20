// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const DEFAULT_CONFIG = {
  po: {
    enabled: true,
    message: "PO Box addresses are not allowed for shipping.",
  },
  military: {
    enabled: true,
    message: "APO/FPO/DPO addresses are not allowed for shipping.",
  },
  rules: [],
};

/**
 * @param {unknown} value
 */
function parseConfig(value) {
  if (!value || typeof value !== "object") return DEFAULT_CONFIG;

  const config = /** @type {Record<string, unknown>} */ (value);
  const po = config.po && typeof config.po === "object"
    ? /** @type {Record<string, unknown>} */ (config.po)
    : {};
  const military = config.military && typeof config.military === "object"
    ? /** @type {Record<string, unknown>} */ (config.military)
    : {};

  return {
    po: {
      enabled: typeof po.enabled === "boolean" ? po.enabled : true,
      message: typeof po.message === "string" && po.message.trim()
        ? po.message
        : DEFAULT_CONFIG.po.message,
    },
    military: {
      enabled: typeof military.enabled === "boolean" ? military.enabled : true,
      message: typeof military.message === "string" && military.message.trim()
        ? military.message
        : DEFAULT_CONFIG.military.message,
    },
    rules: Array.isArray(config.rules) ? config.rules : [],
  };
}

/**
 * @param {unknown} value
 */
function normalize(value) {
  if (typeof value !== "string") return "";

  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 */
function isPoBox(value) {
  const normalized = normalize(value);

  return (
    /\bP\s*O\s*BOX\b/.test(normalized) ||
    /\bP\s*O\s*B\b/.test(normalized) ||
    /\bPOST\s+OFFICE\s+BOX\b/.test(normalized) ||
    /\bPOST\s+BOX\b/.test(normalized)
  );
}

/**
 * @param {string} value
 */
function isMilitaryAddress(value) {
  return /\b(APO|FPO|DPO)\b/.test(normalize(value));
}

/**
 * @param {Record<string, string>} fields
 * @param {Record<string, unknown>} rule
 */
function matchesRule(fields, rule) {
  const field = typeof rule.field === "string" ? rule.field : "";
  const operator = typeof rule.operator === "string" ? rule.operator : "";
  const expected = normalize(rule.value);

  if (!field || !expected) return false;

  const actual = normalize(fields[field]);
  if (!actual) return false;

  if (operator === "eq") return actual === expected;
  if (operator === "contains") return actual.includes(expected);

  return false;
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const step = input.buyerJourney.step;

  if (step !== "CHECKOUT_INTERACTION" && step !== "CHECKOUT_COMPLETION") {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const config = parseConfig(input.cart.validation?.metafield?.jsonValue);
  const errors = [];

  input.cart.deliveryGroups.forEach((deliveryGroup, index) => {
    const address = deliveryGroup.deliveryAddress;
    if (!address) return;

    const addressText = [
      address.address1,
      address.address2,
      address.city,
      address.provinceCode,
      address.zip,
      address.countryCode,
    ].filter(Boolean).join(" ");

    const target = `$.cart.deliveryGroups[${index}].deliveryAddress.address1`;

    if (config.po.enabled && isPoBox(addressText)) {
      errors.push({ message: config.po.message, target });
      return;
    }

    if (config.military.enabled && isMilitaryAddress(addressText)) {
      errors.push({ message: config.military.message, target });
      return;
    }

    const fields = {
      country: address.countryCode ?? "",
      state: address.provinceCode ?? "",
      zip: address.zip ?? "",
      city: address.city ?? "",
      address1: address.address1 ?? "",
      address2: address.address2 ?? "",
    };

    for (const rule of config.rules) {
      if (matchesRule(fields, rule)) {
        errors.push({
          message:
            typeof rule.message === "string" && rule.message.trim()
              ? rule.message
              : "This shipping address is not allowed.",
          target,
        });
        break;
      }
    }
  });

  return {
    operations: [{ validationAdd: { errors } }],
  };
}
