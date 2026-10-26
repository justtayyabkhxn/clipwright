"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, PlugZap, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SUGGESTED_CLAUDE_MODELS, modelLabel, useAiProvider } from "@/hooks/use-ai-provider";
import { cn } from "@/lib/utils";

/** One row of `GET /api/admin/runtime-settings`. Secrets only ever arrive masked. */
export type RuntimeSetting = {
  key: string;
  label: string;
  description: string;
  input_type: "password" | "text";
  source: "environment" | "admin" | "unset";
  configured: boolean;
  /** Masked for secrets (`sk-ant-…abcd`), plain for non-secret values such as the model id. */
  value_hint?: string | null;
  has_admin_value: boolean;
  has_env_value: boolean;
  prefer_admin_value: boolean;
  overridden_by_env: boolean;
  updated_at?: string | null;
};

type ConnectionStatus =
  | "ok" | "missing_key" | "invalid_key" | "permission_denied" | "model_not_found"
  | "rate_limited" | "connection_failed" | "api_error";
type ConnectionResult = { ok: boolean; status: ConnectionStatus; message: string; models: { id: string; display_name: string }[] };

const DEFAULT_MODEL = "claude-opus-5";
const ANTHROPIC_KEY = "ANTHROPIC_API_KEY";
const ASSEMBLY_KEY = "ASSEMBLY_AI_API_KEY";
const MODEL_KEY = "CLAUDE_MODEL";

/** Settings → AI. Admins configure the Claude and AssemblyAI keys; everyone sees what is active. */
export function AiProviderSettings({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("settings.ai");
  const provider = useAiProvider();
  const [settings, setSettings] = useState<RuntimeSetting[] | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [assemblyKey, setAssemblyKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [preferSaved, setPreferSaved] = useState(false);
  const [models, setModels] = useState(SUGGESTED_CLAUDE_MODELS);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const applySettings = useCallback((next: RuntimeSetting[]) => {
    setSettings(next);
    const modelSetting = next.find((setting) => setting.key === MODEL_KEY);
    if (modelSetting?.value_hint) setModel(modelSetting.value_hint);
    const saved = next.filter((setting) => setting.has_admin_value);
    setPreferSaved(saved.length > 0 && saved.every((setting) => setting.prefer_admin_value));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void fetch("/api/admin/runtime-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { settings?: RuntimeSetting[] } | null) => data?.settings && applySettings(data.settings))
      .catch(() => {});
  }, [applySettings, isAdmin]);

  const setting = (key: string) => settings?.find((item) => item.key === key);
  const keySetting = setting(ANTHROPIC_KEY);
  const assemblySetting = setting(ASSEMBLY_KEY);
  const envKeys = (settings ?? []).filter((item) => item.has_env_value).map((item) => item.key);
  const modelOptions = models.some((option) => option.id === model) ? models : [{ id: model, display_name: model }, ...models];

  const missing: string[] = [];
  if (provider?.llm_configured === false) missing.push(t("anthropicKeyName"));
  if (provider?.transcription_configured === false) missing.push(t("assemblyKeyName"));

  const testConnection = async () => {
    setTesting(true);
    setResult(null);
    try {
      const response = await fetch("/api/admin/ai/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", api_key: apiKey.trim() || null, model }),
      });
      const data = (await response.json().catch(() => null)) as ConnectionResult | null;
      if (!response.ok || !data) throw new Error();
      setResult(data);
      const claude = data.models.filter((option) => option.id.startsWith("claude-"));
      if (claude.length) setModels(claude);
    } catch {
      setResult({ ok: false, status: "connection_failed", message: t("testFailed"), models: [] });
    } finally {
      setTesting(false);
    }
  };

  const save = async (body: Record<string, unknown>, successMessage: string, onSaved: () => void) => {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/runtime-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.detail || data?.error || t("saveFailed"));
      applySettings(data.settings);
      onSaved();
      window.dispatchEvent(new Event("ai-provider-changed"));
      toast.success(successMessage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const clearClaude = () => { setApiKey(""); setResult(null); };
  const clearAssembly = () => setAssemblyKey("");

  const saveClaude = () => {
    const updates: Record<string, string> = { [MODEL_KEY]: model };
    if (apiKey.trim()) updates[ANTHROPIC_KEY] = apiKey.trim();
    void save({ updates, prefer_admin_values: { [MODEL_KEY]: preferSaved, [ANTHROPIC_KEY]: preferSaved } }, t("saved"), clearClaude);
  };

  const saveAssembly = () => {
    void save(
      { updates: { [ASSEMBLY_KEY]: assemblyKey.trim() }, prefer_admin_values: { [ASSEMBLY_KEY]: preferSaved } },
      t("assemblySaved"),
      clearAssembly,
    );
  };

  const hasKey = Boolean(apiKey.trim() || keySetting?.configured);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3">
        <div>
          <p className="text-xs text-muted-foreground">{t("active")}</p>
          <p className="text-sm font-medium">{provider ? (modelLabel(provider) ?? provider.provider) : "…"}</p>
          {missing.length > 0 && <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{t("missing", { keys: missing.join(", ") })}</p>}
        </div>
        {provider && (
          <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", provider.configured ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
            {provider.configured ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
            {provider.configured ? t("ready") : t("notConfigured")}
          </span>
        )}
      </div>

      {!isAdmin ? (
        <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>
      ) : (
        <>
          {!keySetting?.configured && (
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                {t("setup1")}{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand underline-offset-2 hover:underline">
                  console.anthropic.com <ExternalLink className="size-3" />
                </a>
              </li>
              <li>{t("setup2")}</li>
              <li>{t("setup3")}</li>
            </ol>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="anthropic-key" className="text-sm">{t("keyLabel")}</Label>
              <KeyStatus id="anthropic-key-status" setting={keySetting} />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <KeyInput
                id="anthropic-key"
                describedBy={keySetting ? "anthropic-key-status" : undefined}
                value={apiKey}
                onChange={(value) => { setApiKey(value); setResult(null); }}
                placeholder={keySetting?.configured ? t("keyReplacePlaceholder") : t("keyPlaceholder")}
              />
              <Button type="button" variant="outline" onClick={() => void testConnection()} disabled={testing || !hasKey}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                {testing ? t("testing") : t("test")}
              </Button>
            </div>
            <KeyHint setting={keySetting} />
            {result && <ConnectionMessage result={result} />}
          </div>

          <div className="space-y-2">
            <Label className="text-sm">{t("model")}</Label>
            <Select value={model} onValueChange={(value) => { setModel(value); setResult(null); }}>
              <SelectTrigger className="w-full sm:w-80"><SelectValue /></SelectTrigger>
              <SelectContent>
                {modelOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.display_name}
                    {option.display_name !== option.id && <span className="ml-2 font-mono text-xs text-muted-foreground">{option.id}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("modelHint")}</p>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            {keySetting?.has_admin_value && (
              <Button type="button" variant="ghost" disabled={saving}
                onClick={() => void save({ delete_keys: [ANTHROPIC_KEY] }, t("removed"), clearClaude)}>
                <Trash2 className="size-4" />{t("remove")}
              </Button>
            )}
            <Button type="button" onClick={saveClaude} disabled={saving || !hasKey}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? t("saving") : t("save")}
            </Button>
          </div>

          <div className="space-y-2 border-t pt-5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="assemblyai-key" className="text-sm">{t("assemblyKeyLabel")}</Label>
              <KeyStatus id="assemblyai-key-status" setting={assemblySetting} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("assemblyKeyHint")}{" "}
              <a href="https://www.assemblyai.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand underline-offset-2 hover:underline">
                assemblyai.com <ExternalLink className="size-3" />
              </a>
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <KeyInput
                id="assemblyai-key"
                describedBy={assemblySetting ? "assemblyai-key-status" : undefined}
                value={assemblyKey}
                onChange={setAssemblyKey}
                placeholder={assemblySetting?.configured ? t("keyReplacePlaceholder") : t("assemblyKeyPlaceholder")}
              />
              {assemblySetting?.has_admin_value && (
                <Button type="button" variant="ghost" disabled={saving}
                  onClick={() => void save({ delete_keys: [ASSEMBLY_KEY] }, t("assemblyRemoved"), clearAssembly)}>
                  <Trash2 className="size-4" />{t("remove")}
                </Button>
              )}
              <Button type="button" onClick={saveAssembly} disabled={saving || !assemblyKey.trim()}>
                {t("assemblySave")}
              </Button>
            </div>
            <KeyHint setting={assemblySetting} />
          </div>

          {envKeys.length > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm">
              <input type="checkbox" checked={preferSaved} onChange={(event) => setPreferSaved(event.target.checked)} className="mt-0.5 size-4 accent-foreground" />
              <span>
                {t("preferSaved")}
                <span className="block text-xs text-muted-foreground">{t("envNote", { keys: envKeys.join(", ") })}</span>
              </span>
            </label>
          )}

          <p className="border-t pt-4 text-xs text-muted-foreground">{t("costNote")}</p>
        </>
      )}
    </div>
  );
}

function KeyInput({ id, describedBy, value, onChange, placeholder }: {
  id: string; describedBy?: string; value: string; onChange: (value: string) => void; placeholder: string;
}) {
  return (
    <div className="relative flex-1">
      <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        aria-describedby={describedBy}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="pl-9 font-mono text-sm"
      />
    </div>
  );
}

/** Per-key status next to the field, from the admin runtime-settings row. */
function KeyStatus({ id, setting }: { id: string; setting?: RuntimeSetting }) {
  const t = useTranslations("settings.ai");
  if (!setting) return null;
  return (
    <span id={id} className={cn("inline-flex items-center gap-1 text-xs font-medium", setting.configured ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
      {setting.configured ? <CheckCircle2 aria-hidden className="size-3.5" /> : <XCircle aria-hidden className="size-3.5" />}
      {setting.configured ? t("ready") : t("notConfigured")}
    </span>
  );
}

function KeyHint({ setting }: { setting?: RuntimeSetting }) {
  const t = useTranslations("settings.ai");
  if (!setting?.value_hint) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {setting.source === "environment" ? t("keyFromEnv", { hint: setting.value_hint }) : t("keySaved", { hint: setting.value_hint })}
    </p>
  );
}

function ConnectionMessage({ result }: { result: ConnectionResult }) {
  const t = useTranslations("settings.ai.status");
  return (
    <div role="status" className={cn(
      "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
      result.ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    )}>
      {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
      <span><span className="font-medium">{t(result.status)}.</span> {result.message}</span>
    </div>
  );
}
