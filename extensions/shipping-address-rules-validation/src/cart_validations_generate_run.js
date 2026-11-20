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
  if (!value || typeof value !== "object") {
    return DEFAULT_CONFIG;
  }

  const config = /** @type {Record<string, unknown>} */ (value);

  return {
    po: {
      enabled:
        typeof config.po === "object" &&
        config.po !== null &&
        "enabled" in config.po
          ? Boolean(config.po.enabled)
          : DEFAULT_CONFIG.po.enabled,
      message:
        typeof config.po === "object" &&
        config.po !== null &&
        "message" in config.po &&
        typeof config.po.message === "string"
          ? config.po.message
          : DEFAULT_CONFIG.po.message,
    },

    military: {
      enabled:
        typeof config.military === "object" &&
        config.military !== null &&
        "enabled" in config.military
          ? Boolean(config.military.enabled)
          : DEFAULT_CONFIG.military.enabled,
      message:
        typeof config.military === "object" &&
        config.military !== null &&
        "message" in config.military &&
        typeof config.military.message === "string"
          ? config.military.message
          : DEFAULT_CONFIG.military.message,
    },

    rules: Array.isArray(config.rules) ? config.rules : [],
  };
}

/**
 * Normalize an address value for reliable matching.
 *
 * @param {unknown} value
 */
function normalize(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} address
 */
function isPoBox(address) {
  const value = normalize(address);

  return (
    /\bP\s*O\s*BOX\b/.test(value) ||
    /\bP\s*O\s*B\b/.test(value) ||
    /\bPOST\s+OFFICE\s+BOX\b/.test(value) ||
    /\bPOST\s+BOX\b/.test(value)
  );
}

/**
 * @param {string} address
 */
function isMilitaryAddress(address) {
  const value = normalize(address);

  return /\b(APO|FPO|DPO)\b/.test(value);
}

/**
 * @param {Record<string, string>} fields
 * @param {Record<string, unknown>} rule
 */
function matchesRule(fields, rule) {
  const field = typeof rule.field === "string" ? rule.field : "";
  const operator = typeof rule.operator === "string" ? rule.operator : "";
  const expected = normalize(rule.value);

  if (!field || !expected) {
    return false;
  }

  const actual = normalize(fields[field]);

  if (!actual) {
    return false;
  }

  switch (operator) {
    case "eq":
      return actual === expected;

    case "contains":
      return actual.includes(expected);

    default:
      return false;
  }
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const config = parseConfig(
    input.cart.validation?.metafield?.jsonValue,
  );

  // Validation should only run when the buyer is actually progressing
  // through checkout.
  if (
    input.buyerJourney.step !== "CHECKOUT_INTERACTION" &&
    input.buyerJourney.step !== "CHECKOUT_COMPLETION"
  ) {
    return {
      operations: [
        {
          validationAdd: {
            errors: [],
          },
        },
      ],
    };
  }

  const errors = [];

  for (const deliveryGroup of input.cart.deliveryGroups) {
    const address = deliveryGroup.deliveryAddress;

    if (!address) {
      continue;
    }

    const addressText = [
      address.address1,
      address.address2,
      address.city,
      address.provinceCode,
      address.zip,
      address.countryCode,
    ]
      .filter(Boolean)
      .join(" ");

    if (config.po.enabled && isPoBox(addressText)) {
      errors.push({
        message: config.po.message,
        target:
          "$.cart.deliveryGroups[0].deliveryAddress.address1",
      });

      continue;
    }

    if (config.military.enabled && isMilitaryAddress(addressText)) {
      errors.push({
        message: config.military.message,
        target:
          "$.cart.deliveryGroups[0].deliveryAddress.address1",
      });

      continue;
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
            typeof rule.message === "string"
              ? rule.message
              : "This shipping address is not allowed.",
          target:
            "$.cart.deliveryGroups[0].deliveryAddress.address1",
        });

        break;
      }
    }
  }

  return {
    operations: [
      {
        validationAdd: {
          errors,
        },
      },
    ],
  };
}
