"use client";

import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, CheckCircle2, Eye, EyeOff, Loader2, PlugZap, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, type AiSettings, type AiSettingsPatch } from "@/lib/api";
import { cn } from "cn";

/** Fournisseurs proposés, dans l'ordre d'affichage (local d'abord). */
const PROVIDERS = [
  {
    id: "ollama",
    title: "Ollama",
    hint: "Local, gratuit, hors-ligne",
    field: "host" as const,
    fieldLabel: "Adresse Ollama",
    fieldPlaceholder: "http://localhost:11434",
    theme: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  {
    id: "lmstudio",
    title: "LM Studio",
    hint: "Local, via serveur OpenAI",
    field: "base_url" as const,
    fieldLabel: "URL du serveur",
    fieldPlaceholder: "http://localhost:1234/v1",
    theme: "text-indigo-600 dark:text-indigo-400",
    dot: "bg-indigo-500",
  },
  {
    id: "openai",
    title: "BYOK · OpenAI",
    hint: "Compatible OpenAI / OpenRouter…",
    field: "base_url" as const,
    fieldLabel: "URL de l'API",
    fieldPlaceholder: "https://api.openai.com/v1",
    theme: "text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
  },
  {
    id: "anthropic",
    title: "Anthropic",
    hint: "Claude, requiert une clé",
    field: "base_url" as const,
    fieldLabel: "URL de l'API",
    fieldPlaceholder: "https://api.anthropic.com",
    theme: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
] as const;
type ProviderId = (typeof PROVIDERS)[number]["id"];

/** Sous-fournisseurs regroupés sous l'entrée unique BYOK. */
const BYOK_IDS = ["openai", "anthropic"] as const;
type ByokId = (typeof BYOK_IDS)[number];
const BYOK_LABEL: Record<ByokId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/** Choix affichés dans la grille : 2 locaux + 1 BYOK regroupant les 2 clés. */
type UiProvider = "ollama" | "lmstudio" | "byok";
function uiOf(provider: ProviderId): UiProvider {
  return provider === "openai" || provider === "anthropic" ? "byok" : provider;
}

/** Champ URL du fournisseur donné. */
function urlField(provider: ProviderId): "host" | "base_url" {
  return provider === "ollama" ? "host" : "base_url";
}

/** Lit une valeur des blocs de réglages sans dépendre de l'union de types. */
function fieldValue(block: unknown, key: string): string {
  if (block && typeof block === "object" && key in block) {
    const value = (block as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

/**
 * État IA du backend, chargé par la page Profil et partagé avec les zones qui
 * affichent un état dégradé (bandeau du chat, badge du mode de filtrage).
 */
export function useAiStatus() {
  const [status, setStatus] = useState<{
    configured: boolean;
    provider: ProviderId;
    label: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getAiSettings()
      .then((settings) => {
        if (!active) return;
        setStatus({
          configured: settings.configured,
          provider: settings.provider,
          label: settings.label,
        });
      })
      .catch(() => {
        // backend injoignable : l'état IA reste inconnu
      });
    return () => {
      active = false;
    };
  }, []);

  return status;
}

/** Case du menu (bouton radio) du choix principal de fournisseur. */
function ProviderCard({
  selected,
  title,
  hint,
  dot,
  needsKey,
  onSelect,
}: {
  selected: boolean;
  title: string;
  hint: string;
  dot: string;
  needsKey?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "border-border focus-visible:ring-ring/60 rounded-xl border p-3 text-left transition-colors focus-visible:ring-3 outline-none",
        selected
          ? "bg-surface-hover border-foreground/40"
          : "bg-surface hover:border-border-foreground/30",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn("size-2.5 rounded-full", selected ? dot : "bg-border")}
        />
        <span className="text-sm font-semibold">{title}</span>
      </span>
      <span className="text-muted-foreground mt-0.5 block text-xs">
        {hint}
        {needsKey && " · clé requise"}
      </span>
    </button>
  );
}

/** Bouton-pastille du sous-choix BYOK (OpenAI vs Anthropic). */
function ByokChip({
  active,
  label,
  onSelect,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "border-border focus-visible:ring-ring/60 rounded-full border px-3 py-1.5 text-xs transition-colors focus-visible:ring-3 outline-none",
        active
          ? "bg-surface-hover border-foreground/40 text-foreground font-medium"
          : "bg-surface text-muted-foreground hover:border-border-foreground/30",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Formulaire des réglages du modèle IA.
 *
 * Les clés API ne quittent jamais le backend en clair : le GET renvoie un masque
 * seul, et le champ clé reste toujours vide (placeholder = masque). En l'absence
 * de saisie, la clé existante est conservée ; « Retirer » l'efface ; une saisie
 * nouvelle la remplace.
 */
export function AiSettingsForm() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("ollama");
  const [model, setModel] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearedKey, setClearedKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  // Mise en forme locale (1 seul provider rechargé à la fois).
  const load = useCallback(async () => {
    try {
      const data = await api.getAiSettings();
      setSettings(data);
      setProvider(data.provider);
      setUrl(fieldValue(data[data.provider], urlField(data.provider)));
      setModel(fieldValue(data[data.provider], "model"));
      setApiKey("");
      setClearedKey(false);
      setTestResult(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const needsKey = provider === "openai" || provider === "anthropic";
  const ui: UiProvider = uiOf(provider);

  // « Enregistré » : le formulaire affiché est la config réellement servie
  // (settings.provider) ET intouchée. Dès qu'un champ est modifié — ou une clé
  // saisie/retirée — le bouton redevient « Enregistrer », pour repersister.
  const block = settings?.[provider];
  const activeSaved = Boolean(
    block &&
      settings?.provider === provider &&
      fieldValue(block, "model") &&
      url === fieldValue(block, urlField(provider)) &&
      model === fieldValue(block, "model") &&
      !apiKey &&
      !clearedKey,
  );

  /** Recharge les champs pour le fournisseur donné (état réel stocké). */
  function switchProvider(next: ProviderId) {
    if (!settings) return;
    setProvider(next);
    setUrl(fieldValue(settings[next], urlField(next)));
    setModel(fieldValue(settings[next], "model"));
    setApiKey("");
    setClearedKey(false);
    setTestResult(null);
  }

  /** Choix de la grille : BYOK réutilise le sous-fournisseur déjà sélectionné. */
  function selectUi(next: UiProvider) {
    switchProvider(next === "byok" ? (provider === "anthropic" ? "anthropic" : "openai") : next);
  }

  /** Sous-choix BYOK : OpenAI ou Anthropic, même logique de saisie. */
  function selectByok(next: ByokId) {
    switchProvider(next);
  }

  /** Patch du formulaire courant (fournisseur + champs + clé si fournie). */
  function buildPatch(): AiSettingsPatch {
    const block: Record<string, string> = {
      [urlField(provider)]: url.trim(),
      model: model.trim(),
    };
    // Clé : nouvelle saisie → remplace ; « retirer » → efface ; vide → conserve.
    if (needsKey) {
      if (apiKey.trim()) {
        block.api_key = apiKey.trim();
      } else if (clearedKey) {
        block.api_key = "";
      }
    }
    return { provider, [provider]: block } as AiSettingsPatch;
  }

  async function save() {
    const patch = buildPatch();
    setBusy(true);
    try {
      await api.saveAiSettings(patch);
      await load();
      setNotice({ kind: "ok", text: "Réglages IA enregistrés." });
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Enregistrement impossible.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      // On teste les valeurs du formulaire (mêmes que le save), pas la config
      // déjà persistée : le backend ne les enregistre pas.
      const res = await api.testAiConnection(buildPatch());
      setTestResult(
        res.ok
          ? {
              ok: true,
              text: `Connexion OK en ${res.latency_ms} ms (${res.model}).`,
            }
          : { ok: false, text: res.error ?? "Connexion impossible." },
      );
    } catch (err) {
      setTestResult({
        ok: false,
        text: err instanceof Error ? err.message : "Backend injoignable.",
      });
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="bg-surface border-border flex min-h-40 items-center justify-center rounded-xl border">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  const configured = settings?.configured ?? false;

  return (
    <section
      aria-labelledby="ai-settings-title"
      className="bg-surface border-border space-y-5 rounded-xl border p-5 sm:p-6"
    >
      <header className="flex flex-wrap items-center gap-3">
        <span className="bg-background/60 text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg">
          <BrainCircuit className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="ai-settings-title" className="text-sm font-semibold">
            Modèle d’IA
          </h3>
          <p className="text-muted-foreground text-xs">
            L’intelligence qui rédige les habillages, les suggestions et le chat.
          </p>
        </div>
        {/* Badge d'état : prêt ou à configurer. */}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
            configured
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          {configured ? (
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
          ) : (
            <XCircle className="size-3.5" aria-hidden="true" />
          )}
          {configured ? "Modèle prêt" : "Non configuré"}
        </span>
      </header>

      <div role="radiogroup" aria-label="Fournisseur d'IA">
        {/* Ollama et LM Studio (locaux) à part ; OpenAI + Anthropic réunis
            sous une seule entrée BYOK : même nature (clé à apporter), même
            formulaire (URL, modèle, clé), seul le fournisseur diffère. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <ProviderCard
            selected={ui === "ollama"}
            title="Ollama"
            hint="Local, gratuit, hors-ligne"
            dot="bg-emerald-500"
            onSelect={() => selectUi("ollama")}
          />
          <ProviderCard
            selected={ui === "lmstudio"}
            title="LM Studio"
            hint="Local, via serveur OpenAI"
            dot="bg-indigo-500"
            onSelect={() => selectUi("lmstudio")}
          />
          <ProviderCard
            selected={ui === "byok"}
            title="BYOK"
            hint="OpenAI ou Anthropic"
            dot="bg-sky-500"
            needsKey
            onSelect={() => selectUi("byok")}
          />
        </div>
        {ui === "byok" && (
          <div
            role="radiogroup"
            aria-label="Fournisseur BYOK"
            className="mt-3 flex flex-wrap items-center gap-2"
          >
            <span className="text-muted-foreground text-xs">Clé API pour&nbsp;:</span>
            {BYOK_IDS.map((id) => (
              <ByokChip
                key={id}
                active={provider === id}
                label={BYOK_LABEL[id]}
                onSelect={() => selectByok(id)}
              />
            ))}
          </div>
        )}
        <p className="text-muted-foreground mt-2 text-xs">
          Le fournisseur sélectionné sert à toute l’application. Les autres
          gardent leurs réglages pour un changement rapide.
        </p>
      </div>

      <div className="border-border/60 space-y-4 border-t pt-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-muted-foreground text-xs">
              {PROVIDERS.find((item) => item.id === provider)?.fieldLabel}
            </span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                PROVIDERS.find((item) => item.id === provider)?.fieldPlaceholder
              }
              className="bg-surface-hover text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/60 h-10 w-full rounded-lg px-3 text-sm outline-none focus-visible:ring-3"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-muted-foreground text-xs">Modèle</span>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={provider === "ollama" ? "qwen2.5:7b" : provider === "anthropic" ? "ex. claude-3-5-sonnet-latest" : "ex. gpt-4o-mini"}
              className="bg-surface-hover text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/60 h-10 w-full rounded-lg px-3 text-sm outline-none focus-visible:ring-3"
            />
          </label>
        </div>

        {needsKey && (
          <div>
            <span className="text-muted-foreground mb-1.5 block text-xs">Clé API</span>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    if (event.target.value) setClearedKey(false);
                  }}
                  placeholder="Insère ta clé API"
                  className="bg-surface-hover text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/60 h-10 w-full rounded-lg pl-3 pr-10 text-sm outline-none focus-visible:ring-3"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((visible) => !visible)}
                  aria-label={showKey ? "Masquer la clé" : "Afficher la clé"}
                  aria-pressed={showKey}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md"
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {/* « Retirer » n'apparaît que pendant l'édition (champ non vide) :
                  taper une clé l'expose ; cliquer arme l'effacement de la clé
                  stockée au prochain « Enregistrer ». Un champ vide conserve la
                  clé déjà enregistrée. */}
              {!clearedKey && apiKey.trim() !== "" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setClearedKey(true);
                    setApiKey("");
                  }}
                  className="text-muted-foreground hover:text-destructive shrink-0 rounded-full"
                >
                  Retirer
                </Button>
              )}
            </div>
            <p className="text-muted-foreground mt-1.5 text-xs">
              Stockée côté serveur uniquement, jamais affichée en clair.
            </p>
          </div>
        )}
      </div>

      {testResult && (
        <p
          role="status"
          className={cn(
            "flex items-center gap-1.5 text-xs",
            testResult.ok ? "text-emerald-700 dark:text-emerald-300" : "text-destructive",
          )}
        >
          {testResult.ok ? (
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
          ) : (
            <XCircle className="size-3.5" aria-hidden="true" />
          )}
          {testResult.text}
        </p>
      )}

      {notice &&
        (notice.kind === "ok" ? (
          <p role="status" className="text-emerald-700 text-xs dark:text-emerald-300">
            {notice.text}
          </p>
        ) : (
          <p role="alert" className="text-destructive text-xs">
            {notice.text}
          </p>
        ))}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-4">
        <Button
          type="button"
          variant="ghost"
          disabled={testing}
          onClick={() => void test()}
          className="text-muted-foreground rounded-full"
        >
          {testing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <PlugZap className="size-4" aria-hidden="true" />
          )}
          Tester la connexion
        </Button>
        <Button type="button" disabled={busy || activeSaved} onClick={() => void save()} className="rounded-full">
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            activeSaved && <CheckCircle2 className="size-4" aria-hidden="true" />
          )}
          {activeSaved ? "Enregistré" : "Enregistrer"}
        </Button>
      </div>
    </section>
  );
}