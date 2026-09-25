"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrainCircuit, CheckCircle2, Eye, EyeOff, Loader2, PlugZap, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, type AiEmbeddedStatus, type AiLocalModel, type AiSettings, type AiSettingsPatch } from "@/lib/api";
import { cn } from "cn";

/** Fournisseurs externes proposés, dans l'ordre d'affichage. */
const PROVIDERS = [
  {
    id: "ollama",
    title: "Ollama",
    hint: "Local, gratuit, hors-ligne",
    field: "host" as const,
    fieldLabel: "Adresse Ollama",
    fieldPlaceholder: "http://localhost:11434",
    dot: "bg-emerald-500",
  },
  {
    id: "lmstudio",
    title: "LM Studio",
    hint: "Local, via serveur OpenAI",
    field: "base_url" as const,
    fieldLabel: "URL du serveur",
    fieldPlaceholder: "http://localhost:1234/v1",
    dot: "bg-indigo-500",
  },
  {
    id: "openai",
    title: "BYOK · OpenAI",
    hint: "Compatible OpenAI / OpenRouter…",
    field: "base_url" as const,
    fieldLabel: "URL de l'API",
    fieldPlaceholder: "https://api.openai.com/v1",
    dot: "bg-sky-500",
  },
  {
    id: "anthropic",
    title: "Anthropic",
    hint: "Claude, requiert une clé",
    field: "base_url" as const,
    fieldLabel: "URL de l'API",
    fieldPlaceholder: "https://api.anthropic.com",
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

/** Choix affichés dans la grille : 2 externes locaux + 1 BYOK regroupant les 2 clés. */
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

/** Taille lisible d'un modèle local. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const gib = 1024 ** 3;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} Go`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} Mo`;
}

/**
 * Événement partagé avec le panneau « Modèles IA locaux » (injecté par l'app
 * desktop). Le choix IA a une seule source de vérité côté backend : quand l'un
 * des deux l'écrit, il prévient l'autre pour qu'il se resynchronise.
 */
const AI_SELECTION_EVENT = "neurobeats:ai-selection";

function announceSelection(): void {
  window.dispatchEvent(new CustomEvent(AI_SELECTION_EVENT));
}

/**
 * État IA du backend, chargé par la page Profil et partagé avec les zones qui
 * affichent un état dégradé (bandeau du chat, badge du mode de filtrage).
 *
 * Inclut l'état du moteur local (loading / ready / error / waiting_for_download)
 * pour que les consommateurs puissent distinguer « jamais configuré » de « en
 * chargement » ou « en erreur ».
 *
 * Synchronisé avec AiSettingsForm via l'événement
 * `neurobeats:ai-engine-status` (dispatché pendant le polling du moteur).
 */
export function useAiStatus() {
  const [status, setStatus] = useState<{
    configured: boolean;
    provider: string;
    label: string;
    engine: AiEmbeddedStatus;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      api
        .getAiSettings()
        .then((settings) => {
          if (!active) return;
          setStatus({
            configured: settings.configured,
            provider: settings.provider,
            label: settings.label,
            engine: settings.engine,
          });
        })
        .catch(() => {
          // backend injoignable : l'état IA reste inconnu
        });
    };
    refresh();
    // L'état IA change AILLEURS (chargement d'un modèle, fournisseur modifié
    // dans un autre bloc) : un fetch unique au montage laissait les bandeaux du
    // chat et de l'assistant sur une vérité périmée.
    const timer = window.setInterval(refresh, 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    // Synchronise avec AiSettingsForm (polling getAiEmbedded pendant loading) :
    // le formulaire dispatch un CustomEvent à chaque mise à jour du moteur.
    const onEngineStatus = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setStatus((prev) => (prev ? { ...prev, engine: detail } : prev));
    };
    window.addEventListener("neurobeats:ai-engine-status", onEngineStatus);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("neurobeats:ai-engine-status", onEngineStatus);
    };
  }, []);

  return status;
}

/**
 * Carte de choix, utilisée pour les modèles locaux COMME pour les fournisseurs
 * externes : c'est une seule liste, un seul élément actif.
 *
 * Un seul modèle est actif à la fois : tous les autres sont explicitement
 * marqués « Inactif », pour que la désélection se voie sans ambiguïté.
 */
function ChoiceCard({
  selected,
  pending,
  title,
  hint,
  dot,
  needsKey,
  busy,
  onSelect,
}: {
  selected: boolean;
  pending: boolean;
  title: string;
  hint: string;
  dot: string;
  needsKey?: boolean;
  busy?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={busy}
      onClick={onSelect}
      className={cn(
        "border-border focus-visible:ring-ring/60 rounded-xl border p-3 text-left transition-colors focus-visible:ring-3 outline-none",
        selected ? "bg-surface-hover border-foreground/40" : "bg-surface hover:border-border-foreground/30",
        !selected && "opacity-60",
        busy && "cursor-wait",
      )}
    >
      <span className="flex items-center gap-2">
        {busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", selected ? dot : "bg-border")} />
        )}
        <span className="truncate text-sm font-semibold">{title}</span>
        {selected ? (
          <span className="bg-primary/15 text-primary ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
            {pending ? "À enregistrer" : "Sélectionné"}
          </span>
        ) : (
          <span className="bg-muted text-muted-foreground ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
            Inactif
          </span>
        )}
      </span>
      <span className="text-muted-foreground mt-0.5 block truncate text-xs">
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
 * Le choix est UNIQUE et plat : chaque modèle local téléchargé et chaque
 * fournisseur externe sont des entrées de la même liste ; un seul est actif,
 * tout le reste est désélectionné (« Inactif »). Choisir un modèle local
 * enregistre le choix immédiatement et déclenche son chargement, dont la
 * progression est affichée.
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
  const [pending, setPending] = useState<ProviderId | null>(null);
  const [model, setModel] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearedKey, setClearedKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  // Signature du choix affiché : sert à détecter un changement venu d'ailleurs
  // (panneau local) sans écraser les champs en cours d'édition.
  const selectionKeyRef = useRef("");

  const selection = settings?.selection;
  const localModels: AiLocalModel[] = settings?.models ?? [];
  const engine: AiEmbeddedStatus = settings?.engine ?? { state: "idle" };
  const persistedLocal = selection?.kind === "embedded" ? selection.model ?? "" : "";
  const persistedExternal: ProviderId | null =
    selection && selection.kind !== "embedded" ? selection.kind : null;
  const loadingModel = engine.state === "loading";
  // UN SEUL élément coché : le brouillon (fournisseur choisi mais pas encore
  // enregistré) s'il existe, sinon le choix persisté. Sans cela, le fournisseur
  // simplement « édité » apparaîtrait sélectionné en même temps que le choix réel.
  const checkedKey =
    pending ?? persistedExternal ?? (persistedLocal ? `embedded:${persistedLocal}` : null);
  const checkedExternalUi = pending
    ? uiOf(pending)
    : persistedExternal
      ? uiOf(persistedExternal)
      : null;
  // Coché mais pas encore enregistré : c'est ce que « Enregistrer » propagera.
  const unsaved = Boolean(pending && pending !== persistedExternal);

  // Mise en forme locale (1 seul provider rechargé à la fois).
  const load = useCallback(async () => {
    try {
      const data = await api.getAiSettings();
      setSettings(data);
      // Propage l'état du moteur vers useAiStatus() (bandeau du chat, taste
      // assistant) sans attendre le prochain refresh (5s).
      window.dispatchEvent(
        new CustomEvent("neurobeats:ai-engine-status", { detail: data.engine }),
      );
      selectionKeyRef.current = JSON.stringify(data.selection);
      const external = data.selection.kind === "embedded" ? "ollama" : data.selection.kind;
      setProvider(external);
      setUrl(fieldValue(data[external], urlField(external)));
      setModel(fieldValue(data[external], "model"));
      setApiKey("");
      setClearedKey(false);
      setPending(null);
      setTestResult(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Un autre bloc (panneau local de l'app desktop) a écrit le choix : on relit
  // pour ne jamais afficher une sélection périmée.
  useEffect(() => {
    const onSelection = () => void load();
    window.addEventListener(AI_SELECTION_EVENT, onSelection);
    return () => window.removeEventListener(AI_SELECTION_EVENT, onSelection);
  }, [load]);

  // Chargement du modèle local : on suit l'état du moteur jusqu'à ce qu'il soit
  // prêt (ou en erreur), plutôt que de laisser l'écran muet pendant ~1 min.
  useEffect(() => {
    if (!loadingModel) return;
    let active = true;
    const timer = window.setInterval(() => {
      api
        .getAiEmbedded()
        .then((status) => {
          if (!active) return;
          setSettings((current) => (current ? { ...current, engine: status } : current));
          // Propage l'état du moteur vers useAiStatus() (bandeau du chat, taste
          // assistant) sans attendre le prochain refresh (5s).
          window.dispatchEvent(
            new CustomEvent("neurobeats:ai-engine-status", { detail: status }),
          );
          if (status.state !== "loading") void load();
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadingModel, load]);

  const needsKey = provider === "openai" || provider === "anthropic";
  const ui: UiProvider = uiOf(provider);

  /** Le formulaire affiché a-t-il été modifié depuis la config enregistrée ? */
  const block = settings?.[provider];
  const externalSaved = Boolean(
    block &&
      persistedExternal === provider &&
      fieldValue(block, "model") &&
      url === fieldValue(block, urlField(provider)) &&
      model === fieldValue(block, "model") &&
      !apiKey &&
      !clearedKey,
  );
  const dirty = unsaved || !externalSaved;

  /** Recharge les champs pour le fournisseur donné (état réel stocké). */
  function switchProvider(next: ProviderId) {
    if (!settings) return;
    setPending(next);
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

  /**
   * Choisir un modèle local : c'est le SEUL enregistrement du choix, donc on
   * l'écrit tout de suite (les fournisseurs externes sont du même coup
   * désélectionnés) et son chargement démarre côté backend.
   */
  async function chooseLocal(localModel: AiLocalModel) {
    setChoosing(true);
    setNotice(null);
    try {
      const data = await api.saveAiSettings({
        selection: { kind: "embedded", model: localModel.model_id },
      });
      setSettings(data);
      // Propage l'état du moteur vers useAiStatus() (bandeau du chat, taste
      // assistant) sans attendre le prochain refresh (5s).
      window.dispatchEvent(
        new CustomEvent("neurobeats:ai-engine-status", { detail: data.engine }),
      );
      setPending(null);
      setNotice({
        kind: "ok",
        text: `${localModel.name} est le seul modèle actif : son chargement démarre.`,
      });
      announceSelection();
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Sélection impossible.",
      });
    } finally {
      setChoosing(false);
    }
  }

  /** Patch du formulaire courant (choix + champs + clé si fournie). */
  function buildPatch(): AiSettingsPatch {
    const patch: Record<string, unknown> = {
      [urlField(provider)]: url.trim(),
      model: model.trim(),
    };
    // Clé : nouvelle saisie → remplace ; « retirer » → efface ; vide → conserve.
    if (needsKey) {
      if (apiKey.trim()) {
        patch.api_key = apiKey.trim();
      } else if (clearedKey) {
        patch.api_key = "";
      }
    }
    // Enregistrer ce fournisseur PROPAGE le choix : il devient l'unique modèle
    // actif, et tout le reste (dont le modèle local) est désélectionné.
    return {
      selection: { kind: provider },
      provider,
      [provider]: patch,
    } as AiSettingsPatch;
  }

  async function save() {
    const patch = buildPatch();
    const wasLocal = persistedLocal;
    setBusy(true);
    try {
      const data = await api.saveAiSettings(patch);
      setSettings(data);
      // Le modèle local n'est pas seulement désélectionné : le moteur le
      // décharge aussitôt. On le dit explicitement, sinon l'utilisateur ne voit
      // qu'un badge changer sans savoir que la mémoire a été libérée.
      const unloaded = Boolean(wasLocal) && data.selection.kind !== "embedded";
      setNotice({
        kind: "ok",
        text: unloaded
          ? `${data.label || data.provider} est le modèle actif : le modèle local a été déchargé.`
          : `${data.label || data.provider} est le modèle actif.`,
      });
      announceSelection();
      await load();
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
              ? "bg-primary/10 text-primary"
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

      {/* Un seul modèle actif : modèles locaux téléchargés ET fournisseurs
          externes sont les entrées de la même liste. */}
      <div role="radiogroup" aria-label="Modèle d'IA actif" className="space-y-4">
        {localModels.length > 0 && (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs font-medium">
              Modèles locaux téléchargés
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="presentation">
              {localModels.map((localModel) => {
                const isChecked = checkedKey === `embedded:${localModel.model_id}`;
                return (
                  <ChoiceCard
                    key={localModel.model_id}
                    selected={isChecked}
                    pending={false}
                    title={localModel.name}
                    hint={`${localModel.model_id} · ${formatBytes(localModel.size_bytes)}`}
                    dot="bg-primary"
                    busy={choosing && !isChecked}
                    onSelect={() => void chooseLocal(localModel)}
                  />
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium">
            Fournisseurs externes
          </p>
          {/* Ollama et LM Studio (locaux) à part ; OpenAI + Anthropic réunis
              sous une seule entrée BYOK : même nature (clé à apporter), même
              formulaire (URL, modèle, clé), seul le fournisseur diffère. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="presentation">
            <ChoiceCard
              selected={ui === "ollama" && checkedExternalUi === "ollama"}
              pending={unsaved && checkedExternalUi === "ollama"}
              title="Ollama"
              hint="Local, gratuit, hors-ligne"
              dot="bg-primary"
              busy={choosing}
              onSelect={() => selectUi("ollama")}
            />
            <ChoiceCard
              selected={ui === "lmstudio" && checkedExternalUi === "lmstudio"}
              pending={unsaved && checkedExternalUi === "lmstudio"}
              title="LM Studio"
              hint="Local, via serveur OpenAI"
              dot="bg-indigo-500"
              busy={choosing}
              onSelect={() => selectUi("lmstudio")}
            />
            <ChoiceCard
              selected={ui === "byok" && checkedExternalUi === "byok"}
              pending={unsaved && checkedExternalUi === "byok"}
              title="BYOK"
              hint="OpenAI ou Anthropic"
              dot="bg-sky-500"
              needsKey
              busy={choosing}
              onSelect={() => selectUi("byok")}
            />
          </div>
          {ui === "byok" && (
            <div
              role="radiogroup"
              aria-label="Fournisseur BYOK"
              className="flex flex-wrap items-center gap-2"
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
        </div>

        <p className="text-muted-foreground text-xs">
          Un seul modèle est actif à la fois : le choix enregistré ici sert à toute
          l’application, et tous les autres sont désactivés.
        </p>
      </div>

      {/* Progression du chargement du modèle local : le backend charge en
          arrière-plan, on affiche où il en est. */}
      {persistedLocal && (
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "flex items-center gap-2 text-xs",
            engine.state === "error" ? "text-destructive" : "text-primary",
          )}
        >
          {loadingModel && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
          {engine.state === "loading"
            ? `Chargement du modèle local ${persistedLocal}… il sera bientôt prêt.`
            : engine.state === "ready"
              ? `Modèle local ${persistedLocal} chargé et utilisé.`
              : engine.state === "error"
                ? `Le chargement de ${persistedLocal} a échoué : ${engine.error ?? "erreur inconnue"}`
                : engine.waiting_for_download
                  ? `Téléchargement de ${persistedLocal} en cours : le moteur le chargera dès qu'il sera prêt.`
                  : `${persistedLocal} est sélectionné mais le moteur ne tourne pas.`}
        </p>
      )}

      {/* Le moteur local est arrêté dès qu'un fournisseur externe prend le
          relais : on le dit, sinon la libération de mémoire reste invisible. */}
      {!persistedLocal && localModels.length > 0 && (
        <p role="status" className="text-muted-foreground text-xs">
          Aucun modèle local actif : les modèles locaux sont désactivés et déchargés,
          {" "}
          {settings?.label ?? "le fournisseur externe"} répond seul.
        </p>
      )}

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
            testResult.ok ? "text-primary" : "text-destructive",
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
          <p role="status" className="text-primary text-xs">
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
        <Button type="button" disabled={busy || !dirty} onClick={() => void save()} className="rounded-full">
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            !dirty && <CheckCircle2 className="size-4" aria-hidden="true" />
          )}
          {dirty ? "Enregistrer" : "Enregistré"}
        </Button>
      </div>
    </section>
  );
}
