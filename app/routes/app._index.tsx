import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

const FUNCTION_HANDLE = "shipping-address-rules-validation";
const VALIDATION_TITLE = "Shipping Address Rules";
const CONFIG_NAMESPACE = "$app:shipping-address-rules";
const CONFIG_KEY = "config";
const MAX_CONFIG_BYTES = 9500;

type Rule = {
  field: "country" | "state" | "zip" | "city" | "address" | "keyword";
  operator: "eq" | "contains";
  value: string;
  message: string;
};

type RuleConfig = {
  po: { enabled: boolean; message: string };
  military: { enabled: boolean; message: string };
  rules: Rule[];
};

const DEFAULT_CONFIG: RuleConfig = {
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

function normalizeConfig(value: unknown): RuleConfig {
  if (!value || typeof value !== "object") return DEFAULT_CONFIG;
  const source = value as Record<string, unknown>;
  const po = source.po && typeof source.po === "object" ? source.po as Record<string, unknown> : {};
  const military = source.military && typeof source.military === "object" ? source.military as Record<string, unknown> : {};
  const rules = Array.isArray(source.rules) ? source.rules : [];

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
    rules: rules
      .filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === "object")
      .map((rule) => ({
        field: ["country", "state", "zip", "city", "address", "keyword"].includes(String(rule.field))
          ? rule.field as Rule["field"]
          : "address",
        operator: (rule.operator === "eq" ? "eq" : "contains") as Rule["operator"],
        value: typeof rule.value === "string" ? rule.value : "",
        message: typeof rule.message === "string" ? rule.message : "",
      }))
      .slice(0, 50),
  };
}

function configBytes(config: RuleConfig) {
  return new TextEncoder().encode(JSON.stringify(config)).length;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query ShippingAddressRulesSettings {
        validations(first: 25) {
          nodes {
            id
            title
            enabled
            blockOnFailure
            metafield(namespace: "$app:shipping-address-rules", key: "config") {
              jsonValue
            }
            shopifyFunction {
              handle
            }
          }
        }
      }
    `,
  );

  const data = await response.json();
  const validation = data.data?.validations?.nodes?.find(
    (item: { shopifyFunction?: { handle?: string | null } | null }) =>
      item.shopifyFunction?.handle === FUNCTION_HANDLE,
  );

  return {
    validation: validation
      ? {
          id: validation.id,
          enabled: validation.enabled,
          blockOnFailure: validation.blockOnFailure,
          config: normalizeConfig(validation.metafield?.jsonValue),
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  const responseJson = async (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (intent === "toggle") {
    const enabled = formData.get("enabled") === "true";

    if (!enabled) {
      const validationId = String(formData.get("validationId") ?? "");
      if (!validationId) return responseJson({ ok: true, enabled: false });

      const response = await admin.graphql(
        `#graphql
          mutation DisableShippingAddressRules($id: ID!) {
            validationUpdate(
              id: $id
              validation: { enable: false, blockOnFailure: false }
            ) {
              validation { id enabled blockOnFailure }
              userErrors { field message code }
            }
          }
        `,
        { variables: { id: validationId } },
      );
      const data = await response.json();
      const result = data.data?.validationUpdate;

      if (result?.userErrors?.length) {
        return responseJson({ ok: false, errors: result.userErrors }, 400);
      }
      return responseJson({ ok: true, enabled: false });
    }

    const config = normalizeConfig(
      formData.get("config") ? JSON.parse(String(formData.get("config"))) : DEFAULT_CONFIG,
    );
    const serialized = JSON.stringify(config);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
      return responseJson({ ok: false, error: `Configuration exceeds ${MAX_CONFIG_BYTES} bytes.` }, 400);
    }

    const validationId = String(formData.get("validationId") ?? "");
    if (validationId) {
      const response = await admin.graphql(
        `#graphql
          mutation EnableShippingAddressRules($id: ID!, $value: String!) {
            validationUpdate(
              id: $id
              validation: {
                enable: true
                blockOnFailure: false
                metafields: [{
                  namespace: "$app:shipping-address-rules"
                  key: "config"
                  type: "json"
                  value: $value
                }]
              }
            ) {
              validation { id enabled blockOnFailure }
              userErrors { field message code }
            }
          }
        `,
        { variables: { id: validationId, value: serialized } },
      );
      const data = await response.json();
      const result = data.data?.validationUpdate;
      if (result?.userErrors?.length) {
        return responseJson({ ok: false, errors: result.userErrors }, 400);
      }
      return responseJson({ ok: true, enabled: true });
    }

    const response = await admin.graphql(
      `#graphql
        mutation CreateShippingAddressRules($value: String!) {
          validationCreate(
            validation: {
              functionHandle: "shipping-address-rules-validation"
              title: "Shipping Address Rules"
              enable: true
              blockOnFailure: false
              metafields: [{
                namespace: "$app:shipping-address-rules"
                key: "config"
                type: "json"
                value: $value
              }]
            }
          ) {
            validation { id enabled blockOnFailure }
            userErrors { field message code }
          }
        }
      `,
      { variables: { value: serialized } },
    );
    const data = await response.json();
    const result = data.data?.validationCreate;
    if (result?.userErrors?.length) {
      return responseJson({ ok: false, errors: result.userErrors }, 400);
    }
    return responseJson({ ok: true, enabled: true, created: true });
  }

  let config: RuleConfig;
  try {
    config = normalizeConfig(JSON.parse(String(formData.get("config") ?? "{}")));
  } catch {
    return responseJson({ ok: false, error: "Invalid configuration." }, 400);
  }

  const serialized = JSON.stringify(config);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_CONFIG_BYTES) {
    return responseJson({
      ok: false,
      error: `Configuration exceeds ${MAX_CONFIG_BYTES} bytes. Remove some rules or shorten messages.`,
      bytes,
      maxBytes: MAX_CONFIG_BYTES,
    }, 400);
  }

  const validationId = String(formData.get("validationId") ?? "");

  if (validationId) {
    const response = await admin.graphql(
      `#graphql
        mutation UpdateShippingAddressRules($id: ID!, $value: String!) {
          validationUpdate(
            id: $id
            validation: {
              enable: true
              blockOnFailure: false
              metafields: [{
                namespace: "$app:shipping-address-rules"
                key: "config"
                type: "json"
                value: $value
              }]
            }
          ) {
            validation { id enabled blockOnFailure }
            userErrors { field message code }
          }
        }
      `,
      { variables: { id: validationId, value: serialized } },
    );
    const data = await response.json();
    const result = data.data?.validationUpdate;
    if (result?.userErrors?.length) {
      return responseJson({ ok: false, errors: result.userErrors }, 400);
    }
    return responseJson({ ok: true, enabled: true, bytes });
  }

  const response = await admin.graphql(
    `#graphql
      mutation CreateShippingAddressRules($value: String!) {
        validationCreate(
          validation: {
            functionHandle: "shipping-address-rules-validation"
            title: "Shipping Address Rules"
            enable: true
            blockOnFailure: false
            metafields: [{
              namespace: "$app:shipping-address-rules"
              key: "config"
              type: "json"
              value: $value
            }]
          }
        ) {
          validation { id enabled blockOnFailure }
          userErrors { field message code }
        }
      }
    `,
    { variables: { value: serialized } },
  );
  const data = await response.json();
  const result = data.data?.validationCreate;
  if (result?.userErrors?.length) {
    return responseJson({ ok: false, errors: result.userErrors }, 400);
  }
  return responseJson({ ok: true, enabled: true, created: true, bytes });
};

export default function Index() {
  const { validation } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{
    ok?: boolean;
    enabled?: boolean;
    created?: boolean;
    error?: string;
    errors?: Array<{ message?: string }>;
    bytes?: number;
  }>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const [config, setConfig] = useState<RuleConfig>(validation?.config ?? DEFAULT_CONFIG);
  const [enabled, setEnabled] = useState(Boolean(validation?.enabled));

  const handledFetcherData = useRef<typeof fetcher.data>(undefined);

  useEffect(() => {
    if (!fetcher.data || handledFetcherData.current === fetcher.data) return;
    handledFetcherData.current = fetcher.data;

    if (fetcher.data.ok) {
      setEnabled(Boolean(fetcher.data.enabled));
      shopify.toast.show(fetcher.data.created ? "Protection enabled" : "Settings saved");
      revalidator.revalidate();
    } else if (fetcher.data.error) {
      setEnabled(Boolean(validation?.enabled));
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify, revalidator, validation]);

  useEffect(() => {
    if (validation) {
      setConfig(validation.config);
      setEnabled(validation.enabled);
    }
  }, [validation]);

  const bytes = useMemo(() => configBytes(config), [config]);
  const overLimit = bytes > MAX_CONFIG_BYTES;
  const saving = fetcher.state !== "idle";

  const updateRule = (index: number, patch: Partial<Rule>) => {
    setConfig((current) => ({
      ...current,
      rules: current.rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule,
      ),
    }));
  };

  const addRule = () => {
    setConfig((current) => ({
      ...current,
      rules: [
        ...current.rules,
        {
          field: "keyword",
          operator: "contains",
          value: "",
          message: "This shipping address is not allowed.",
        },
      ],
    }));
  };

  const removeRule = (index: number) => {
    setConfig((current) => ({
      ...current,
      rules: current.rules.filter((_, ruleIndex) => ruleIndex !== index),
    }));
  };

  const submitConfig = (intent: "save" | "toggle", nextEnabled = enabled) => {
    const form = new FormData();
    form.set("intent", intent);
    form.set("config", JSON.stringify(config));
    form.set("enabled", String(nextEnabled));
    if (validation?.id) form.set("validationId", validation.id);
    fetcher.submit(form, { method: "post" });
  };

  const toggleProtection = (event: Event) => {
    const next = (event.currentTarget as unknown as { checked: boolean }).checked;
    setEnabled(next);
    submitConfig("toggle", next);
  };

  return (
    <s-page heading="Shipping Address Rules">
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={overLimit || saving ? true : undefined}
        onClick={() => submitConfig("save")}
      >
        {saving ? "Saving…" : "Save settings"}
      </s-button>

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-switch
              label="Protect checkout"
              details="Block restricted shipping addresses before the customer can complete checkout."
              checked={enabled}
              onChange={toggleProtection}
            />
            <s-badge
              tone={enabled ? "success" : "neutral"}
              color={enabled ? "strong" : "base"}
            >
              {enabled ? "ON" : "OFF"}
            </s-badge>
          </s-stack>
          {!validation && (
            <s-banner tone="info">
              Protection is not installed yet. Turn it on to create the Shopify
              checkout validation automatically.
            </s-banner>
          )}
          {validation && !validation.blockOnFailure && (
            <s-text tone="neutral">
              Runtime failures do not block checkout. Only actual rule violations do.
            </s-text>
          )}
        </s-stack>
      </s-section>

      <s-section heading="PO Box protection">
        <s-stack gap="base">
          <s-checkbox
            label="Block PO Box addresses"
            details="Covers PO Box, P.O. Box, POB, P.O.B, Post Office Box and Post Box variants."
            checked={config.po.enabled}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                po: { ...current.po, enabled: (event.currentTarget as unknown as { checked: boolean }).checked },
              }))
            }
          />
          <s-text-field
            label="Customer-facing error message"
            value={config.po.message}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                po: { ...current.po, message: event.currentTarget.value },
              }))
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="APO / FPO / DPO protection">
        <s-stack gap="base">
          <s-checkbox
            label="Block military addresses"
            details="Blocks APO, FPO and DPO shipping addresses."
            checked={config.military.enabled}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                military: {
                  ...current.military,
                  enabled: (event.currentTarget as unknown as { checked: boolean }).checked,
                },
              }))
            }
          />
          <s-text-field
            label="Customer-facing error message"
            value={config.military.message}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                military: {
                  ...current.military,
                  message: event.currentTarget.value,
                },
              }))
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Custom shipping rules">
        <s-stack gap="base">
          <s-text tone="neutral">
            Add precise rules for country, state, ZIP, city, address or keyword matches.
          </s-text>
          {config.rules.map((rule, index) => (
            <s-box key={index} padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="base">
                <s-select
                  label="Field"
                  value={rule.field}
                  onChange={(event) =>
                    updateRule(index, {
                      field: event.currentTarget.value as Rule["field"],
                    })
                  }
                >
                  <s-option value="country">Country</s-option>
                  <s-option value="state">State / Province</s-option>
                  <s-option value="zip">ZIP / Postal code</s-option>
                  <s-option value="city">City</s-option>
                  <s-option value="address">Address</s-option>
                  <s-option value="keyword">Keyword</s-option>
                </s-select>
                <s-select
                  label="Operator"
                  value={rule.operator}
                  onChange={(event) =>
                    updateRule(index, {
                      operator: event.currentTarget.value as Rule["operator"],
                    })
                  }
                >
                  <s-option value="contains">Contains</s-option>
                  <s-option value="eq">Equals</s-option>
                </s-select>
                <s-text-field
                  label="Value"
                  value={rule.value}
                  onChange={(event) =>
                    updateRule(index, { value: event.currentTarget.value })
                  }
                />
                <s-text-field
                  label="Customer-facing error message"
                  value={rule.message}
                  onChange={(event) =>
                    updateRule(index, { message: event.currentTarget.value })
                  }
                />
                <s-button tone="critical" variant="tertiary" onClick={() => removeRule(index)}>
                  Remove rule
                </s-button>
              </s-stack>
            </s-box>
          ))}
          <s-button onClick={addRule}>Add custom rule</s-button>
        </s-stack>
      </s-section>

      <s-section heading="Configuration size">
        <s-stack gap="small-200">
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>{bytes.toLocaleString()} / {MAX_CONFIG_BYTES.toLocaleString()} bytes</s-text>
            <s-text tone={overLimit ? "critical" : bytes > 8000 ? "caution" : "neutral"}>
              {overLimit ? "Limit exceeded" : bytes > 8000 ? "Approaching limit" : "Within limit"}
            </s-text>
          </s-stack>
          <progress
            max={MAX_CONFIG_BYTES}
            value={Math.min(bytes, MAX_CONFIG_BYTES)}
            style={{ width: "100%" }}
            aria-label="Configuration size"
          />
          <s-text tone="neutral">
            App limit: 9,500 bytes. The checkout Function receives this JSON configuration
            on every validation run.
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-stack gap="base">
          <s-paragraph>
            Rules run server-side in Shopify checkout. A matching rule blocks checkout
            with the configured merchant message.
          </s-paragraph>
          <s-paragraph>
            Validation runtime failures are configured with blockOnFailure=false, so a
            temporary Function failure does not unnecessarily block customers.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
