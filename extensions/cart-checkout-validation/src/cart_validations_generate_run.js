// @ts-check

/**
 * Shipping Address Rules — Cart & Checkout Validation Function.
 *
 * Design goals:
 * - High precision: never block generic "Unit", "Suite", "PMB" or "Box #".
 * - V1 blocks PO Box and APO/FPO/DPO only when enabled.
 * - Merchant custom rules are exact/contains only.
 * - No network calls during checkout.
 */

/** @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput */
/** @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult */

const DEFAULT_CONFIG = {
  po: {
    enabled: true,
    msg: "PO Box addresses are not allowed for shipping."
  },
  mil: {
    enabled: true,
    msg: "APO/FPO/DPO addresses are not allowed for shipping."
  },
  rules: []
};

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function parseConfig(value) {
  if (!value || typeof value !== "object") return DEFAULT_CONFIG;
  const config = /** @type {Record<string, any>} */ (value);
  return {
    po: {
      enabled: config.po?.enabled !== false,
      msg: typeof config.po?.msg === "string" && config.po.msg.trim()
        ? config.po.msg
        : DEFAULT_CONFIG.po.msg
    },
    mil: {
      enabled: config.mil?.enabled !== false,
      msg: typeof config.mil?.msg === "string" && config.mil.msg.trim()
        ? config.mil.msg
        : DEFAULT_CONFIG.mil.msg
    },
    rules: Array.isArray(config.rules) ? config.rules : []
  };
}

/**
 * @param {string} value
 */
function normalize(value) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[.\u00B7]/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 */
function isPoBox(value) {
  const n = normalize(value);
  return /(^| )P O BOX( |$)/.test(n) ||
    /(^| )PO BOX( |$)/.test(n) ||
    /(^| )P O B( |$)/.test(n) ||
    /(^| )POB( |$)/.test(n) ||
    /(^| )POST OFFICE BOX( |$)/.test(n) ||
    /(^| )POST BOX( |$)/.test(n);
}

/**
 * @param {string} value
 */
function isMilitaryAddress(value) {
  const n = normalize(value);
  return /(^| )(APO|FPO|DPO)( |$)/.test(n);
}

/**
 * @param {Record<string, any>} rule
 * @param {Record<string, string>} address
 */
function matchesRule(rule, address) {
  const field = typeof rule.f === "string" ? rule.f : "";
  const op = typeof rule.o === "string" ? rule.o : "";
  const expected = typeof rule.v === "string" ? normalize(rule.v) : "";
  if (!field || !expected || !["eq", "contains"].includes(op)) return false;

  if (field === "keyword") {
    const haystack = normalize(
      [address.address1, address.address2, address.city, address.provinceCode, address.zip, address.countryCode]
        .filter(Boolean)
        .join(" ")
    );
    return op === "eq" ? haystack === expected : haystack.includes(expected);
  }

  const actual = normalize(address[field] || "");
  return op === "eq" ? actual === expected : actual.includes(expected);
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function run(input) {
  const step = input.buyerJourney?.step;
  if (step !== "CHECKOUT_INTERACTION" && step !== "CHECKOUT_COMPLETION") {
    return { operations: [] };
  }

  const config = parseConfig(input.cart.validation?.metafield?.jsonValue);
  const errors = [];

  for (const group of input.cart.deliveryGroups ?? []) {
    const address = group.deliveryAddress;
    if (!address) continue;

    const address1 = address.address1 || "";
    const address2 = address.address2 || "";

    if (config.po.enabled && (isPoBox(address1) || isPoBox(address2))) {
      errors.push({
        message: config.po.msg,
        target: "$.cart.deliveryGroups[0].deliveryAddress.address1"
      });
      continue;
    }

    if (config.mil.enabled && (isMilitaryAddress(address1) || isMilitaryAddress(address2))) {
      errors.push({
        message: config.mil.msg,
        target: "$.cart.deliveryGroups[0].deliveryAddress.address1"
      });
      continue;
    }

    const addressData = {
      address1,
      address2,
      city: address.city || "",
      provinceCode: address.provinceCode || "",
      zip: address.zip || "",
      countryCode: address.countryCode || ""
    };

    for (const rule of config.rules) {
      if (matchesRule(rule, addressData)) {
        errors.push({
          message: typeof rule.msg === "string" && rule.msg.trim()
            ? rule.msg
            : "This shipping address is not eligible for delivery.",
          target: "$.cart.deliveryGroups[0].deliveryAddress.address1"
        });
        break;
      }
    }
  }

  return {
    operations: [
      {
        validationAdd: {
          errors
        }
      }
    ]
  };
}
