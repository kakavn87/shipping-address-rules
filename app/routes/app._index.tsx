import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import appStylesHref from "../styles/shipping-address-rules.css?url";

export function links() {
  return [{ rel: "stylesheet", href: appStylesHref }];
}

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
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const revalidator = useRevalidator();

  const [config, setConfig] = useState<RuleConfig>(validation?.config ?? DEFAULT_CONFIG);
  const [enabled, setEnabled] = useState(Boolean(validation?.enabled));

  const handledFetcherData = useRef<typeof fetcher.data>(undefined);

  useEffect(() => {
    if (!fetcher.data || handledFetcherData.current === fetcher.data) return;
    handledFetcherData.current = fetcher.data;

    if (fetcher.data.ok) {
      setEnabled(Boolean(fetcher.data.enabled));
      setToast({ message: fetcher.data.created ? "Protection enabled" : "Settings saved" });
      revalidator.revalidate();
    } else if (fetcher.data.error) {
      setEnabled(Boolean(validation?.enabled));
      setToast({ message: fetcher.data.error, error: true });
    }
  }, [fetcher.data, revalidator, validation]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
    <s-page className="sar-page">
      {toast && <div className={"sar-toast" + (toast.error ? " error" : "")} role="status"><span className="sar-toast-icon">{toast.error ? "!" : "✓"}</span><span>{toast.message}</span><button className="sar-toast-close" onClick={() => setToast(null)} aria-label="Close notification">×</button></div>
      <div className="sar-top">
        <div className="sar-brand">
          <div className="sar-logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3 20 6v5c0 5-3.2 8.5-8 10-4.8-1.5-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg></div>
          <div><h1 className="sar-title">Shipping Address Rules</h1><p className="sar-subtitle">Prevent restricted shipping addresses before checkout</p></div>
        </div>
        <div className="sar-status"><span className="sar-dot"/>{enabled ? "Protected" : "Protection off"}</div>
      </div>

      <div className="sar-hero">
        <div className="sar-hero-left">
          <div className="sar-hero-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 3 20 6v5c0 5-3.2 8.5-8 10-4.8-1.5-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg></div>
          <div><h2 className="sar-h2">Checkout Protection</h2><p className="sar-copy">Block restricted shipping addresses before the customer can complete checkout.</p></div>
        </div>
        <button className={"sar-switch" + (enabled ? "" : " off")} onClick={toggleProtection} aria-pressed={enabled}>
          {enabled ? "ON" : "OFF"}<span className="sar-knob"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">{enabled ? <path d="m6 12 4 4 8-8"/> : <path d="M7 7l10 10M17 7 7 17"/>}</svg></span>
        </button>
      </div>

      {!validation && <div className="sar-card" style={{marginTop:18,borderColor:"#bfdbfe",background:"#eff6ff"}}><strong style={{color:"#1e40af"}}>Protection is not installed yet.</strong><span style={{marginLeft:8,color:"#475467",fontSize:13}}>Turn it on to create the Shopify checkout validation automatically.</span></div>}

      <div className="sar-grid">
        <div className="sar-card sar-protection">
          <div><div className="sar-card-head"><div className="sar-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m4 8 8-4 8 4-8 4-8-4Z"/><path d="M4 8v8l8 4 8-4V8"/></svg></div><div><h2 className="sar-h2" style={{fontSize:17}}>PO Box Protection</h2><p className="sar-copy">Block PO Box addresses and common variants.</p></div></div><span className="sar-badge">{config.po.enabled ? "Protection active" : "Protection disabled"}</span></div>
          <button className={"sar-check" + (config.po.enabled ? " checked" : "")} onClick={() => setConfig((x) => ({...x,po:{...x.po,enabled:!x.po.enabled}}))} aria-label="Toggle PO Box protection">{config.po.enabled && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.7"><path d="m5 12 4 4L19 6"/></svg>}</button>
        </div>
        <div className="sar-card sar-protection">
          <div><div className="sar-card-head"><div className="sar-card-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 11h18M12 3v18M5 7l14 10M19 7 5 17"/></svg></div><div><h2 className="sar-h2" style={{fontSize:17}}>APO / FPO / DPO Protection</h2><p className="sar-copy">Block military shipping addresses.</p></div></div><span className="sar-badge">{config.military.enabled ? "Protection active" : "Protection disabled"}</span></div>
          <button className={"sar-check" + (config.military.enabled ? " checked" : "")} onClick={() => setConfig((x) => ({...x,military:{...x.military,enabled:!x.military.enabled}}))} aria-label="Toggle military protection">{config.military.enabled && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.7"><path d="m5 12 4 4L19 6"/></svg>}</button>
        </div>
      </div>

      <div className="sar-card sar-section">
        <div className="sar-section-head">
          <div className="sar-section-title"><div className="sar-mini-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg></div><div><h3>Custom Shipping Rules</h3><p>Add precise rules for countries, regions, ZIP codes and address keywords.</p></div></div>
          <button className="sar-add" onClick={addRule}>+ Add rule</button>
        </div>
        <div className="sar-table">
          <div className="sar-table-head"><span>#</span><span>Field</span><span>Condition</span><span>Value</span><span>Action</span><span/></div>
          {config.rules.length === 0 ? <div className="sar-empty">No custom rules yet. Add a rule when you need more control.</div> : config.rules.map((rule,index) => (
            <div key={index}>
              <div className="sar-row">
                <span>{index + 1}</span>
                <select value={rule.field} onChange={(e) => updateRule(index,{field:e.currentTarget.value as Rule["field"]})}><option value="country">Country</option><option value="state">State / Province</option><option value="zip">ZIP Code</option><option value="city">City</option><option value="address">Address</option><option value="keyword">Keyword</option></select>
                <select value={rule.operator} onChange={(e) => updateRule(index,{operator:e.currentTarget.value as Rule["operator"]})}><option value="contains">Contains</option><option value="eq">Equals</option></select>
                <input value={rule.value} onChange={(e) => updateRule(index,{value:e.currentTarget.value})}/>
                <span className="sar-block-pill">⊘ Block</span>
                <button className="sar-icon-btn" onClick={() => removeRule(index)} aria-label="Delete rule"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7l1-3h4l1 3"/></svg></button>
              </div>
              <div style={{padding:"0 14px 14px 45px"}}><label className="sar-field-label">Customer-facing error message</label><input className="sar-message-input" value={rule.message} onChange={(e) => updateRule(index,{message:e.currentTarget.value})}/></div>
            </div>
          ))}
        </div>
      </div>

      <div className="sar-info-grid">
        <div className="sar-card sar-info"><div className="sar-info-title"><div className="sar-mini-icon">i</div><span>How it works</span></div><p>Rules run server-side in Shopify checkout using a Checkout Validation Function. Matching addresses show the configured customer-facing message.</p><p className="sar-note">Runtime failures use blockOnFailure=false, so temporary Function failures do not unnecessarily block customers.</p></div>
        <div className="sar-card sar-info"><div className="sar-info-title"><div className="sar-mini-icon">⚡</div><span>Function Status</span><span className="sar-active">{enabled ? "Active" : "Inactive"}</span></div><p><strong style={{color:enabled ? "#067647" : "#667085"}}>● {enabled ? "Active" : "Inactive"}</strong> · Checkout validation is {enabled ? "running" : "disabled"}.</p><p className="sar-note">{validation ? "Validation is installed and connected to this store." : "Validation will be created automatically when protection is enabled."}</p></div>
      </div>

      <div className="sar-card sar-size"><div className="sar-size-top"><span>Configuration size</span><span>{bytes.toLocaleString()} / {MAX_CONFIG_BYTES.toLocaleString()} bytes · {overLimit ? "Limit exceeded" : bytes > 8000 ? "Approaching limit" : "Within limit"}</span></div><div className="sar-progress"><span style={{width:(Math.min((bytes / MAX_CONFIG_BYTES) * 100,100) + "%")}}/></div><div className="sar-note">App limit: 9,500 bytes. This configuration is delivered to the checkout Function on each validation run.</div></div>

      <div className="sar-savebar"><button className="sar-save" disabled={overLimit || saving} onClick={() => submitConfig("save")}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/></svg>{saving ? "Saving…" : "Save settings"}</button></div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
