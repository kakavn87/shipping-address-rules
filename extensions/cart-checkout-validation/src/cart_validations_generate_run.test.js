import { describe, expect, it } from "vitest";
import { run } from "./cart_validations_generate_run.js";

const base = (address, config = undefined) => ({
  buyerJourney: { step: "CHECKOUT_INTERACTION" },
  cart: {
    deliveryGroups: [{ deliveryAddress: address }],
    validation: {
      metafield: config === undefined ? null : { jsonValue: config }
    }
  }
});

const address = (address1, extra = {}) => ({
  address1,
  address2: "",
  city: "Miami",
  provinceCode: "FL",
  zip: "33101",
  countryCode: "US",
  ...extra
});

describe("Shipping Address Rules", () => {
  it("blocks PO BOX", () => {
    const result = run(base(address("PO BOX 123")));
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  it("blocks P.O. Box", () => {
    const result = run(base(address("P.O. Box 123")));
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  it("blocks POB", () => {
    const result = run(base(address("POB 123")));
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  it("blocks Post Office Box", () => {
    const result = run(base(address("Post Office Box 123")));
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  it("blocks APO/FPO/DPO", () => {
    for (const value of ["APO AE 09012", "FPO AE 09501", "DPO AE 09801"]) {
      const result = run(base(address(value)));
      expect(result.operations[0].validationAdd.errors).toHaveLength(1);
    }
  });

  it("does not block normal addresses", () => {
    const result = run(base(address("123 Boxwood Street")));
    expect(result.operations[0].validationAdd.errors).toHaveLength(0);
  });

  it("does not block Suite/Unit/PMB by default", () => {
    for (const value of ["123 Main St Suite 100", "123 Main St Unit 5", "123 Main St PMB 12", "Box 12 Main Street"]) {
      const result = run(base(address(value)));
      expect(result.operations[0].validationAdd.errors).toHaveLength(0);
    }
  });

  it("supports custom ZIP rules", () => {
    const config = {
      po: { enabled: false },
      mil: { enabled: false },
      rules: [{ f: "zip", o: "eq", v: "99501", msg: "We do not ship to this ZIP code." }]
    };
    const result = run(base(address("123 Main St", { zip: "99501" }), config));
    expect(result.operations[0].validationAdd.errors[0].message).toBe("We do not ship to this ZIP code.");
  });

  it("supports keyword rules", () => {
    const config = {
      po: { enabled: false },
      mil: { enabled: false },
      rules: [{ f: "keyword", o: "contains", v: "RESTRICTED" }]
    };
    const result = run(base(address("Restricted Logistics Center"), config));
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  it("does nothing during cart interaction", () => {
    const input = base(address("PO BOX 123"));
    input.buyerJourney.step = "CART_INTERACTION";
    expect(run(input).operations).toHaveLength(0);
  });

  it("uses merchant custom messages", () => {
    const config = {
      po: { enabled: true, msg: "We cannot ship to PO Boxes." },
      mil: { enabled: false },
      rules: []
    };
    const result = run(base(address("PO BOX 123"), config));
    expect(result.operations[0].validationAdd.errors[0].message).toBe("We cannot ship to PO Boxes.");
  });

  it("can disable PO Box protection", () => {
    const config = {
      po: { enabled: false },
      mil: { enabled: false },
      rules: []
    };
    const result = run(base(address("PO BOX 123"), config));
    expect(result.operations[0].validationAdd.errors).toHaveLength(0);
  });
});
