// ─── Agent Identity Manager ──────────────────────────────────────────────────
// Refactored: types/parsers/serializers → identity-types.ts
//             extractProjectEssence()   → project-essence.ts
// This file: class AgentIdentityManager + re-exports for backward compatibility
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ─── Re-export everything from identity-types (backward compatibility) ───────
// Consumers import from "./agent-identity" — these re-exports keep them working
export {
  BOOTSTRAP_FILE,
  bootstrapToMarkdown,
  buildIdentityPrompt,
  IDENTITY_FILE,
  identityToMarkdown,
  isPlaceholder,
  parseIdentityFromMarkdown,
  parseProgrammingPrefsFromMarkdown,
  parseSoulFromMarkdown,
  parseUserFromMarkdown,
  PRIMARY_AGENT_NAME,
  PROGRAMMING_PREFS_FILE,
  programmingPrefsToMarkdown,
  SOUL_FILE,
  soulToMarkdown,
  USER_FILE,
  userToMarkdown,
  type AgentContext,
  type AgentIdentity,
  type AgentSoul,
  type ProgrammingPrefs,
  type ProjectEssence,
  type UserProfile,
} from "./identity-types";

// ─── Re-export extractProjectEssence from project-essence ────────────────────
export { extractProjectEssence } from "./project-essence";

// ─── Internal imports (used by the class) ────────────────────────────────────
import type {
  AgentContext,
  AgentIdentity,
  AgentSoul,
  ProgrammingPrefs,
  ProjectEssence,
  UserProfile,
} from "./identity-types";

import {
  BOOTSTRAP_FILE,
  bootstrapToMarkdown,
  buildIdentityPrompt,
  IDENTITY_FILE,
  identityToMarkdown,
  parseIdentityFromMarkdown,
  parseProgrammingPrefsFromMarkdown,
  parseSoulFromMarkdown,
  parseUserFromMarkdown,
  PRIMARY_AGENT_NAME,
  PROGRAMMING_PREFS_FILE,
  programmingPrefsToMarkdown,
  SOUL_FILE,
  soulToMarkdown,
  USER_FILE,
  userToMarkdown,
} from "./identity-types";

import { extractProjectEssence as extractProjectEssenceFromRepo } from "./project-essence";

// ─── Re-export i18n utilities for backward compatibility ─────────────────────
export {
  detectVSCodeLanguage,
  getBootstrapStrings,
  interpolate,
  LANG_MAP,
  type BootstrapStrings,
} from "./i18n";

// ─── Internal i18n import ────────────────────────────────────────────────────
import { detectVSCodeLanguage, getBootstrapStrings, interpolate } from "./i18n";

// ─── Emoji validation utilities ─────────────────────────────────────────────

/**
 * Check if a string is a valid emoji (not just regular text).
 * Catches "sombrero de paja", "misil nuclear", etc.
 */
function isValidEmoji(str: string): boolean {
  const trimmed = str.trim();
  if (trimmed.length === 0) return false;
  // If it contains any Unicode letter, it's text, not emoji
  if (/\p{Letter}/u.test(trimmed)) return false;
  // Pure digits are not emoji
  if (/^\p{Number}+$/u.test(trimmed)) return false;
  // Suspiciously long = probably not emoji
  if ([...trimmed].length > 10) return false;
  return true;
}

/** Map common words (ES/EN/FR/PT/DE) to contextually relevant emojis */
const TEXT_TO_EMOJI: Record<string, string[]> = {
  // Pirates & Adventure
  pirata: ["🏴‍☠️", "⚓", "🦜", "🗡️"],
  pirate: ["🏴‍☠️", "⚓", "🦜"],
  sombrero: ["🎩", "👒", "🤠"],
  hat: ["🎩", "👒", "🤠"],
  chapeau: ["🎩", "👒"],
  paja: ["🌾", "👒", "🏴‍☠️"],
  straw: ["🌾", "👒"],
  paille: ["🌾", "👒"],
  tesoro: ["💰", "🏴‍☠️", "🗝️"],
  treasure: ["💰", "🏴‍☠️", "🗝️"],
  // Military & Weapons
  misil: ["🚀", "💥", "☢️"],
  missile: ["🚀", "💥", "☢️"],
  nuclear: ["☢️", "⚛️", "💥"],
  bomba: ["💣", "💥"],
  bomb: ["💣", "💥"],
  espada: ["🗡️", "⚔️"],
  sword: ["🗡️", "⚔️"],
  arma: ["🔫", "🗡️"],
  weapon: ["🔫", "🗡️"],
  waffe: ["🔫", "🗡️"],
  // Animals
  gato: ["🐱", "🐈", "😺"],
  cat: ["🐱", "🐈"],
  chat: ["🐱", "🐈"],
  katze: ["🐱"],
  perro: ["🐕", "🐶"],
  dog: ["🐕", "🐶"],
  chien: ["🐕", "🐶"],
  hund: ["🐕", "🐶"],
  lobo: ["🐺"],
  wolf: ["🐺"],
  loup: ["🐺"],
  dragon: ["🐉", "🐲"],
  drache: ["🐉", "🐲"],
  serpiente: ["🐍"],
  snake: ["🐍"],
  serpent: ["🐍"],
  schlange: ["🐍"],
  aguila: ["🦅"],
  eagle: ["🦅"],
  aigle: ["🦅"],
  adler: ["🦅"],
  leon: ["🦁"],
  lion: ["🦁"],
  lowe: ["🦁"],
  oso: ["🐻"],
  bear: ["🐻"],
  ours: ["🐻"],
  bar: ["🐻"],
  buho: ["🦉"],
  owl: ["🦉"],
  hibou: ["🦉"],
  eule: ["🦉"],
  pulpo: ["🐙"],
  octopus: ["🐙"],
  pieuvre: ["🐙"],
  unicornio: ["🦄"],
  unicorn: ["🦄"],
  licorne: ["🦄"],
  einhorn: ["🦄"],
  tiburon: ["🦈"],
  shark: ["🦈"],
  requin: ["🦈"],
  hai: ["🦈"],
  zorro: ["🦊"],
  fox: ["🦊"],
  renard: ["🦊"],
  fuchs: ["🦊"],
  mono: ["🐒", "🐵"],
  monkey: ["🐒", "🐵"],
  singe: ["🐒"],
  affe: ["🐒"],
  conejo: ["🐰", "🐇"],
  rabbit: ["🐰", "🐇"],
  lapin: ["🐰"],
  hase: ["🐰"],
  loro: ["🦜"],
  parrot: ["🦜"],
  perroquet: ["🦜"],
  papagei: ["🦜"],
  mariposa: ["🦋"],
  butterfly: ["🦋"],
  papillon: ["🦋"],
  abeja: ["🐝"],
  bee: ["🐝"],
  abeille: ["🐝"],
  biene: ["🐝"],
  pajaro: ["🐦", "🕊️"],
  bird: ["🐦", "🕊️"],
  oiseau: ["🐦"],
  vogel: ["🐦"],
  // Tech & Science
  robot: ["🤖"],
  cerebro: ["🧠"],
  brain: ["🧠"],
  cerveau: ["🧠"],
  gehirn: ["🧠"],
  computadora: ["💻", "🖥️"],
  computer: ["💻", "🖥️"],
  ordinateur: ["💻"],
  codigo: ["💻", "⌨️"],
  code: ["💻", "⌨️"],
  ciencia: ["🔬", "🧪"],
  science: ["🔬", "🧪"],
  wissenschaft: ["🔬", "🧪"],
  estrella: ["⭐", "🌟", "✨"],
  star: ["⭐", "🌟", "✨"],
  etoile: ["⭐", "🌟"],
  rayo: ["⚡", "🌩️"],
  lightning: ["⚡", "🌩️"],
  bolt: ["⚡"],
  blitz: ["⚡"],
  fuego: ["🔥", "🌋"],
  fire: ["🔥", "🌋"],
  feu: ["🔥"],
  feuer: ["🔥"],
  // Nature
  sol: ["☀️", "🌞"],
  sun: ["☀️", "🌞"],
  soleil: ["☀️"],
  sonne: ["☀️"],
  luna: ["🌙", "🌕"],
  moon: ["🌙", "🌕"],
  lune: ["🌙"],
  mond: ["🌙"],
  flor: ["🌸", "🌺", "🌹"],
  flower: ["🌸", "🌺", "🌹"],
  fleur: ["🌸"],
  blume: ["🌸"],
  arbol: ["🌳", "🌲", "🌴"],
  tree: ["🌳", "🌲"],
  arbre: ["🌳"],
  baum: ["🌳"],
  montana: ["⛰️", "🏔️"],
  mountain: ["⛰️", "🏔️"],
  montagne: ["⛰️"],
  mar: ["🌊", "🏖️"],
  sea: ["🌊", "🏖️"],
  mer: ["🌊"],
  meer: ["🌊"],
  oceano: ["🌊", "🐋"],
  ocean: ["🌊", "🐋"],
  // Objects & Fantasy
  corona: ["👑", "🤴", "👸"],
  crown: ["👑"],
  couronne: ["👑"],
  krone: ["👑"],
  diamante: ["💎", "💍"],
  diamond: ["💎", "💍"],
  diamant: ["💎"],
  corazon: ["❤️", "💖"],
  heart: ["❤️", "💖"],
  coeur: ["❤️"],
  herz: ["❤️"],
  fantasma: ["👻"],
  ghost: ["👻"],
  fantome: ["👻"],
  geist: ["👻"],
  calavera: ["💀", "☠️"],
  skull: ["💀", "☠️"],
  crane: ["💀"],
  ninja: ["🥷"],
  mago: ["🧙", "🔮"],
  wizard: ["🧙", "🔮"],
  magicien: ["🧙"],
  alien: ["👽", "🛸"],
  extraterrestre: ["👽", "🛸"],
  cafe: ["☕"],
  coffee: ["☕"],
  kaffee: ["☕"],
  cactus: ["🌵"],
  hongo: ["🍄"],
  mushroom: ["🍄"],
  // Food
  pizza: ["🍕"],
  taco: ["🌮"],
  hamburguesa: ["🍔"],
  burger: ["🍔"],
  // Emotions & Vibes
  risa: ["😂", "🤣"],
  laugh: ["😂", "🤣"],
  rire: ["😂"],
  genio: ["🧞", "💡"],
  genius: ["🧞", "💡"],
  genie: ["🧞"],
  cool: ["😎", "🆒"],
  guay: ["😎"],
  loco: ["🤪", "😜"],
  crazy: ["🤪", "😜"],
  fou: ["🤪"],
  // Music & Culture
  musica: ["🎵", "🎸", "🎶"],
  music: ["🎵", "🎸"],
  musik: ["🎵", "🎸"],
  libro: ["📚", "📖"],
  book: ["📚", "📖"],
  livre: ["📚"],
  buch: ["📚"],
  mundo: ["🌍", "🌎"],
  world: ["🌍", "🌎"],
  monde: ["🌍"],
  welt: ["🌍"],
  llave: ["🗝️", "🔑"],
  key: ["🗝️", "🔑"],
  cle: ["🗝️"],
  magia: ["🪄", "✨", "🔮"],
  magic: ["🪄", "✨", "🔮"],
  magie: ["🪄", "✨"],
  trueno: ["⛈️", "🌩️"],
  thunder: ["⛈️", "🌩️"],
  tonnerre: ["⛈️"],
  cohete: ["🚀"],
  rocket: ["🚀"],
  fusee: ["🚀"],
  rakete: ["🚀"],
};

/** Suggest emojis based on text input by matching keywords (offline fallback) */
function suggestEmojisForText(text: string): string[] {
  // Strip accents for matching
  const lower = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const suggestions = new Set<string>();

  for (const word of lower.split(/\s+/)) {
    for (const [key, emojis] of Object.entries(TEXT_TO_EMOJI)) {
      const nKey = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (nKey === word || word.includes(nKey) || nKey.includes(word)) {
        for (const e of emojis) suggestions.add(e);
      }
    }
  }

  return [...suggestions].slice(0, 8);
}

/**
 * Use VS Code's Language Model API (Copilot) to suggest contextually
 * relevant emojis for a given text description.
 * Falls back to the static dictionary if no model is available.
 */
async function suggestEmojisWithAI(
  text: string,
  log?: (msg: string) => void,
): Promise<string[]> {
  const localSuggestions = suggestEmojisForText(text);

  try {
    // Try lightweight model first, then any copilot model
    let models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4o-mini",
    });
    if (!models.length) {
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    }
    if (!models.length) {
      log?.("[EmojiAI] No Copilot models available, using static fallback");
      return localSuggestions;
    }

    const model = models[0];
    log?.(`[EmojiAI] Using model: ${model.name}`);

    const prompt = `The user typed "${text}" as an emoji for their AI assistant identity.
  Suggest exactly 10 emojis that best represent this phrase with HIGH semantic precision.
Rules:
- Return ONLY the emojis separated by spaces, nothing else
- No text, no numbers, no explanations
  - Prioritize literal meaning of words in "${text}" over mood/vibe emojis
  - Avoid generic scenic emojis unless explicitly present in the phrase
  - Prefer object/role/action emojis directly tied to the phrase

  Example input: "straw hat"
  Good output: 👒 🌾 🎩 🤠 🧺 🏴‍☠️ 🪶 🧵 🧺 🌤️
  Bad output: 🌺 🍹 🏖️ 🧁 🌙 🦄 🤖`;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const tokenSource = new vscode.CancellationTokenSource();

    // 10 second timeout
    const timeout = setTimeout(() => tokenSource.cancel(), 10_000);

    const response = await model.sendRequest(messages, {}, tokenSource.token);
    let result = "";
    for await (const fragment of response.text) {
      result += fragment;
    }
    clearTimeout(timeout);

    // Parse by grapheme to preserve compound emojis like 🏄‍♂️ and 🏴‍☠️
    const aiSuggestions = extractEmojiGraphemes(result);

    if (aiSuggestions.length > 0) {
      // Hybrid ranking: local semantic matches first, then AI creativity.
      // This keeps results congruent for phrases like "sombrero de paja".
      const merged = [
        ...new Set([...localSuggestions, ...aiSuggestions]),
      ].slice(0, 10);
      log?.(`[EmojiAI] Suggested: ${merged.join(" ")}`);
      return merged;
    }

    log?.("[EmojiAI] Could not parse emojis from response, using fallback");
    return localSuggestions;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`[EmojiAI] Error: ${msg}, using static fallback`);
    return localSuggestions;
  }
}

function extractEmojiGraphemes(input: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const suggestions = new Set<string>();

  for (const { segment } of segmenter.segment(input)) {
    const candidate = segment.trim();
    if (!candidate) continue;
    if (/\p{Letter}|\p{Number}/u.test(candidate)) continue;
    if (
      !(
        /\p{Extended_Pictographic}/u.test(candidate) ||
        /\p{Emoji}/u.test(candidate)
      )
    )
      continue;

    // Drop standalone gender symbols that often leak from combined emojis (e.g. 🏄‍♂️ -> ♂️)
    if (candidate === "♂️" || candidate === "♀️") continue;

    suggestions.add(candidate);
  }

  return [...suggestions].slice(0, 10);
}

// ─── AgentIdentityManager ────────────────────────────────────────────────────
// Manages identity/soul/user files with caching + interactive wizards

export class AgentIdentityManager {
  private identityCache: AgentIdentity | null | undefined = undefined;
  private soulCache: AgentSoul | null | undefined = undefined;
  private userCache: UserProfile | null | undefined = undefined;
  private programmingPrefsCache: ProgrammingPrefs | null | undefined =
    undefined;
  private memoryPath: string;
  private globalConfig:
    | import("./global-config-provider").GlobalConfigProvider
    | null;

  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
    globalConfig?:
      | import("./global-config-provider").GlobalConfigProvider
      | null,
  ) {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>(
      "memoryFolder",
      ".project-brain/memory",
    );
    this.memoryPath = path.join(workspaceFolder.uri.fsPath, memoryFolder);
    this.globalConfig = globalConfig ?? null;
  }

  /** Whether this manager should read/write from global storage */
  private isGlobalScope(): boolean {
    if (!this.globalConfig) return false;
    return this.globalConfig.getScope() === "global";
  }

  /** Get the global config provider (for external callers that need it) */
  getGlobalConfig():
    | import("./global-config-provider").GlobalConfigProvider
    | null {
    return this.globalConfig;
  }

  // ─── Identity ────────────────────────────────────────────────────

  loadIdentity(): AgentIdentity | null {
    if (this.identityCache !== undefined) return this.identityCache;

    // Global scope: read from GlobalConfigProvider first
    if (this.isGlobalScope() && this.globalConfig) {
      const globalIdentity = this.globalConfig.loadIdentity();
      if (globalIdentity) {
        this.identityCache = globalIdentity;
        this.log(
          `Identity loaded from global: "${globalIdentity.name}" (${globalIdentity.creature})`,
        );
        return this.identityCache;
      }
    }

    // Fallback: read from local project files
    const filePath = path.join(this.memoryPath, IDENTITY_FILE);
    try {
      if (!fs.existsSync(filePath)) {
        this.identityCache = null;
        return null;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      this.identityCache = parseIdentityFromMarkdown(
        content,
        detectVSCodeLanguage(),
      );
      if (this.identityCache) {
        this.log(
          `Identity loaded: "${this.identityCache.name}" (${this.identityCache.creature})`,
        );
      }
      return this.identityCache;
    } catch (err) {
      this.log(`Failed to load identity: ${err}`);
      this.identityCache = null;
      return null;
    }
  }

  saveIdentity(identity: AgentIdentity): void {
    // Save to global if scope is global
    if (this.isGlobalScope() && this.globalConfig) {
      this.globalConfig.saveIdentity(identity);
    }

    // Always save to local project files too (for agent instruction generation)
    this.ensureMemoryDir();
    fs.writeFileSync(
      path.join(this.memoryPath, IDENTITY_FILE),
      identityToMarkdown(identity),
      "utf-8",
    );
    this.identityCache = identity;
    this.log(`Identity saved: "${identity.name}" (${identity.creature})`);
  }

  // ─── Soul ────────────────────────────────────────────────────────

  loadSoul(): AgentSoul | null {
    if (this.soulCache !== undefined) return this.soulCache;

    // Global scope: read from GlobalConfigProvider first
    if (this.isGlobalScope() && this.globalConfig) {
      const globalSoul = this.globalConfig.loadSoul();
      if (globalSoul) {
        this.soulCache = globalSoul;
        this.log("Soul loaded from global");
        return this.soulCache;
      }
    }

    // Fallback: local project files
    const filePath = path.join(this.memoryPath, SOUL_FILE);
    try {
      if (!fs.existsSync(filePath)) {
        this.soulCache = null;
        return null;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      this.soulCache = parseSoulFromMarkdown(content);
      if (this.soulCache) this.log("Soul loaded");
      return this.soulCache;
    } catch (err) {
      this.log(`Failed to load soul: ${err}`);
      this.soulCache = null;
      return null;
    }
  }

  saveSoul(soul: AgentSoul): void {
    // Save to global if scope is global
    if (this.isGlobalScope() && this.globalConfig) {
      this.globalConfig.saveSoul(soul);
    }

    // Always save locally too
    this.ensureMemoryDir();
    fs.writeFileSync(
      path.join(this.memoryPath, SOUL_FILE),
      soulToMarkdown(soul),
      "utf-8",
    );
    this.soulCache = soul;
    this.log("Soul saved");
  }

  private buildAutoLore(
    identity: AgentIdentity | null,
    tone: string,
    approach: string,
    essence: ProjectEssence | null,
  ): string[] {
    const name = identity?.name || PRIMARY_AGENT_NAME;
    const projectType = essence?.projectType || "software";
    return [
      `${name} nació para ayudar en proyectos de ${projectType} con enfoque práctico y entregable.`,
      `Su forma de trabajo combina un tono ${tone.toLowerCase()} con una estrategia ${approach.toLowerCase()}.`,
      "Aprende del historial del repositorio para mantener continuidad entre sesiones y decisiones técnicas.",
      "Prioriza cambios verificables, seguros y alineados con el estilo real del proyecto.",
    ];
  }

  private buildAutoTopics(essence: ProjectEssence | null): string[] {
    const projectType = essence?.projectType || "proyectos de software";
    const dynamicTopics = [
      ...(essence?.languages || []).map(
        (language) => `Desarrollo y buenas prácticas en ${language}`,
      ),
      ...(essence?.frameworks || []).map(
        (framework) => `Arquitectura y uso efectivo de ${framework}`,
      ),
      ...(essence?.keyDependencies || [])
        .slice(0, 5)
        .map((dependency) => `Integración y mantenimiento de ${dependency}`),
    ];

    const defaults = [
      `Arquitectura y evolución de ${projectType}`,
      "Testing y validación de cambios de código",
      "Depuración de errores con análisis de causa raíz",
      "Automatización de flujos de desarrollo y QA",
    ];

    return [...new Set([...dynamicTopics, ...defaults])].slice(0, 8);
  }

  private buildAutoMessageExamples(
    identity: AgentIdentity | null,
  ): Array<{ user: string; agent: string }> {
    const name = identity?.name || PRIMARY_AGENT_NAME;
    return [
      {
        user: "¿Qué hacemos primero para arreglar este bug?",
        agent: `${name} traza primero la causa raíz con evidencia, luego aplica un fix pequeño y lo valida con pruebas.`,
      },
      {
        user: "¿Puedes resumirme el estado actual del proyecto?",
        agent: `${name} te da resumen corto: qué cambió, qué falta, riesgos activos y siguiente paso recomendado.`,
      },
    ];
  }

  // ─── User Profile ────────────────────────────────────────────────

  loadUser(): UserProfile | null {
    if (this.userCache !== undefined) return this.userCache;

    // Global scope: read from GlobalConfigProvider first
    if (this.isGlobalScope() && this.globalConfig) {
      const globalUser = this.globalConfig.loadUser();
      if (globalUser) {
        this.userCache = globalUser;
        this.log(`User loaded from global: "${globalUser.name}"`);
        return this.userCache;
      }
    }

    // Fallback: local project files
    const filePath = path.join(this.memoryPath, USER_FILE);
    try {
      if (!fs.existsSync(filePath)) {
        this.userCache = null;
        return null;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      this.userCache = parseUserFromMarkdown(content);
      if (this.userCache) this.log(`User loaded: "${this.userCache.name}"`);
      return this.userCache;
    } catch (err) {
      this.log(`Failed to load user profile: ${err}`);
      this.userCache = null;
      return null;
    }
  }

  saveUser(user: UserProfile): void {
    // Save to global if scope is global
    if (this.isGlobalScope() && this.globalConfig) {
      this.globalConfig.saveUser(user);
    }

    // Always save locally too
    this.ensureMemoryDir();
    fs.writeFileSync(
      path.join(this.memoryPath, USER_FILE),
      userToMarkdown(user),
      "utf-8",
    );
    this.userCache = user;
    this.log(`User profile saved: "${user.name}"`);
  }

  // ─── Programming Preferences ─────────────────────────────────────

  loadProgrammingPrefs(): ProgrammingPrefs | null {
    if (this.programmingPrefsCache !== undefined)
      return this.programmingPrefsCache;

    // Global scope: read from GlobalConfigProvider first
    if (this.isGlobalScope() && this.globalConfig) {
      const globalPrefs = this.globalConfig.loadProgrammingPrefs();
      if (globalPrefs) {
        this.programmingPrefsCache = globalPrefs;
        this.log("Programming preferences loaded from global");
        return this.programmingPrefsCache;
      }
    }

    // Fallback: local project files
    const filePath = path.join(this.memoryPath, PROGRAMMING_PREFS_FILE);
    try {
      if (!fs.existsSync(filePath)) {
        this.programmingPrefsCache = null;
        return null;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      this.programmingPrefsCache = parseProgrammingPrefsFromMarkdown(content);
      if (this.programmingPrefsCache)
        this.log("Programming preferences loaded");
      return this.programmingPrefsCache;
    } catch (err) {
      this.log(`Failed to load programming preferences: ${err}`);
      this.programmingPrefsCache = null;
      return null;
    }
  }

  saveProgrammingPrefs(prefs: ProgrammingPrefs): void {
    // Save to global if scope is global
    if (this.isGlobalScope() && this.globalConfig) {
      this.globalConfig.saveProgrammingPrefs(prefs);
    }

    // Always save locally too
    this.ensureMemoryDir();
    fs.writeFileSync(
      path.join(this.memoryPath, PROGRAMMING_PREFS_FILE),
      programmingPrefsToMarkdown(prefs),
      "utf-8",
    );
    this.programmingPrefsCache = prefs;
    this.log("Programming preferences saved");
  }

  // ─── Bootstrap ───────────────────────────────────────────────────

  hasBootstrap(): boolean {
    return fs.existsSync(path.join(this.memoryPath, BOOTSTRAP_FILE));
  }

  createBootstrap(): void {
    this.ensureMemoryDir();
    fs.writeFileSync(
      path.join(this.memoryPath, BOOTSTRAP_FILE),
      bootstrapToMarkdown(),
      "utf-8",
    );
    this.log(
      "Bootstrap file created — agent will introduce itself on first chat",
    );
  }

  getBootstrapContent(): string | null {
    const filePath = path.join(this.memoryPath, BOOTSTRAP_FILE);
    try {
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  deleteBootstrap(): void {
    const filePath = path.join(this.memoryPath, BOOTSTRAP_FILE);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.log("Bootstrap file deleted — agent has been born");
      }
    } catch (err) {
      this.log(`Failed to delete bootstrap: ${err}`);
    }
  }

  // ─── Full context ────────────────────────────────────────────────

  loadFullContext(): AgentContext {
    return {
      identity: this.loadIdentity(),
      soul: this.loadSoul(),
      user: this.loadUser(),
      essence: this.extractProjectEssence(),
      programmingPrefs: this.loadProgrammingPrefs(),
    };
  }

  hasIdentity(): boolean {
    return this.loadIdentity() !== null;
  }

  /** Check if a LOCAL identity file exists in this workspace (ignores global). */
  hasLocalIdentity(): boolean {
    const filePath = path.join(this.memoryPath, IDENTITY_FILE);
    return fs.existsSync(filePath);
  }

  /** Clear identity cache so next loadIdentity() re-reads from disk/config. */
  clearIdentityCache(): void {
    this.identityCache = undefined;
  }

  getIdentityPrompt(): string | null {
    const identity = this.loadIdentity();
    if (!identity) return null;
    return buildIdentityPrompt(
      identity,
      this.loadSoul(),
      this.loadUser(),
      this.extractProjectEssence(),
      this.loadProgrammingPrefs(),
    );
  }

  /**
   * Extract project essence from repo files.
   * Delegates to the standalone function in project-essence.ts.
   */
  extractProjectEssence() {
    return extractProjectEssenceFromRepo(this.workspaceFolder.uri.fsPath);
  }

  invalidateCache(): void {
    this.identityCache = undefined;
    this.soulCache = undefined;
    this.userCache = undefined;
    this.programmingPrefsCache = undefined;
  }

  /**
   * Create default identity/soul/user files if they don't exist.
   * Called when the user skips the wizard — ensures hooks always
   * have something to read (graceful defaults instead of missing files).
   */
  ensureDefaultIdentityFiles(): void {
    this.ensureMemoryDir();

    // 08_AGENT_IDENTITY.md
    const identityPath = path.join(this.memoryPath, IDENTITY_FILE);
    if (!fs.existsSync(identityPath)) {
      const defaultIdentity: AgentIdentity = {
        name: PRIMARY_AGENT_NAME,
        creature: "AI assistant",
        vibe: "Warm and conversational",
        emoji: "🧠",
        theme: "Warm and conversational AI assistant",
        language: detectVSCodeLanguage(),
      };
      fs.writeFileSync(
        identityPath,
        identityToMarkdown(defaultIdentity),
        "utf-8",
      );
      this.log("Default identity file created (08_AGENT_IDENTITY.md)");
    }

    // 09_AGENT_SOUL.md
    const soulPath = path.join(this.memoryPath, SOUL_FILE);
    if (!fs.existsSync(soulPath)) {
      const identityForSoul = this.loadIdentity() ?? {
        name: PRIMARY_AGENT_NAME,
        creature: "AI assistant",
        vibe: "Warm and conversational",
        emoji: "🧠",
        theme: "Warm and conversational AI assistant",
        language: detectVSCodeLanguage(),
      };
      const essence = this.extractProjectEssence();
      const defaultSoul: AgentSoul = {
        tone: "Be the assistant you'd actually want to talk to",
        boundaries:
          "- When in doubt, ask before acting.\n- Never send half-baked solutions.\n- Don't run destructive commands unless explicitly asked.",
        approach: "Balanced — adapts based on context",
        customRules: "",
        lore: this.buildAutoLore(
          identityForSoul,
          "Be the assistant you'd actually want to talk to",
          "Balanced — adapts based on context",
          essence,
        ),
        topics: this.buildAutoTopics(essence),
        messageExamples: this.buildAutoMessageExamples(identityForSoul),
      };
      fs.writeFileSync(soulPath, soulToMarkdown(defaultSoul), "utf-8");
      this.log("Default soul file created (09_AGENT_SOUL.md)");
    }

    // 10_USER_PROFILE.md
    const userPath = path.join(this.memoryPath, USER_FILE);
    if (!fs.existsSync(userPath)) {
      const defaultUser: UserProfile = {
        name: "User",
        preferredAddress: "User",
        timezone: "",
        notes: "",
      };
      fs.writeFileSync(userPath, userToMarkdown(defaultUser), "utf-8");
      this.log("Default user file created (10_USER_PROFILE.md)");
    }
  }

  // ─── Interactive wizard (QuickPick fallback) ─────────────────────

  private async selectFromQuickPickWithCustom(
    title: string,
    placeHolder: string,
    items: vscode.QuickPickItem[],
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
      qp.title = title;
      qp.placeholder = placeHolder;
      qp.ignoreFocusOut = true;

      const baseItems = [...items];
      let currentCustomLabel = "";

      const updateItems = () => {
        const typed = qp.value.trim();
        const typedLower = typed.toLowerCase();
        const exactExists = baseItems.some(
          (item) => item.label.toLowerCase() === typedLower,
        );

        if (typed.length > 0 && !exactExists) {
          currentCustomLabel = typed;
          const customItem: vscode.QuickPickItem = {
            label: typed,
            description: "Custom value",
            alwaysShow: true,
          };
          qp.items = [customItem, ...baseItems];
          qp.activeItems = [customItem];
          return;
        }

        currentCustomLabel = "";
        qp.items = baseItems;
      };

      qp.items = baseItems;

      qp.onDidChangeValue(() => {
        updateItems();
      });

      qp.onDidAccept(() => {
        const selected = qp.selectedItems[0];
        if (!selected) {
          resolve(null);
          qp.hide();
          return;
        }

        const value =
          currentCustomLabel && selected.label === currentCustomLabel
            ? currentCustomLabel
            : selected.label;
        resolve(value);
        qp.hide();
      });

      qp.onDidHide(() => {
        resolve(null);
        qp.dispose();
      });

      qp.show();
    });
  }

  async configureInteractive(): Promise<AgentIdentity | null> {
    this.log("Starting agent identity configuration...");

    // ─── Step 1: Language FIRST (critical — drives all subsequent UX) ───
    const detectedLang = detectVSCodeLanguage();
    // Get initial i18n (will refine after language selection)
    let i18n = getBootstrapStrings();

    const langItems: vscode.QuickPickItem[] = [
      { label: "English" },
      { label: "Spanish / Español" },
      { label: "Portuguese (BR) / Português" },
      { label: "Portuguese (PT) / Português" },
      { label: "French / Français" },
      { label: "German / Deutsch" },
      { label: "Japanese / 日本語" },
      { label: "Chinese / 中文" },
      { label: "Korean / 한국어" },
      { label: "Italian / Italiano" },
      { label: "Russian / Русский" },
      { label: "Arabic / العربية" },
      { label: "Hindi / हिन्दी" },
      { label: "Turkish / Türkçe" },
      { label: "Polish / Polski" },
      { label: "Dutch / Nederlands" },
    ];

    // Move detected language to top so it's pre-selected
    const sortedLangItems = [
      ...langItems.filter((i) => i.label === detectedLang),
      ...langItems.filter((i) => i.label !== detectedLang),
    ];

    const langPick = await vscode.window.showQuickPick(sortedLangItems, {
      title: i18n.wizardLanguageTitle,
      placeHolder: interpolate(i18n.wizardLanguagePlaceholder, {
        detected: detectedLang,
      }),
      ignoreFocusOut: true,
    });
    if (!langPick) return null;

    // Refresh i18n strings to the language the user just picked
    i18n = getBootstrapStrings(langPick.label);

    // ─── Step 2: Creature ───────────────────────────────────────────
    // Items translated via i18n
    const creatureItems: vscode.QuickPickItem[] = i18n.creatureItems;
    const creatureValue = await this.selectFromQuickPickWithCustom(
      i18n.wizardCreatureTitle,
      i18n.wizardCreaturePlaceholder,
      creatureItems,
    );
    if (!creatureValue) return null;

    // ─── Step 3: Vibe ───────────────────────────────────────────────
    const vibeItems: vscode.QuickPickItem[] = i18n.vibeItems;
    const vibeValue = await this.selectFromQuickPickWithCustom(
      i18n.wizardVibeTitle,
      i18n.wizardVibePlaceholder,
      vibeItems,
    );
    if (!vibeValue) return null;

    // ─── Step 4: Emoji ──────────────────────────────────────────────
    const emojiItems: vscode.QuickPickItem[] = i18n.emojiItems;
    let emojiValue = await this.selectFromQuickPickWithCustom(
      i18n.wizardEmojiTitle,
      i18n.wizardEmojiPlaceholder,
      emojiItems,
    );
    if (!emojiValue) return null;

    // Validate: if user typed text instead of an actual emoji, suggest with AI
    if (!isValidEmoji(emojiValue)) {
      const aiSuggestions = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "🧠 Generating emoji suggestions...",
          cancellable: false,
        },
        () => suggestEmojisWithAI(emojiValue!, (m) => this.log(m)),
      );
      const genericFallbacks = ["🧠", "🤖", "🏴‍☠️", "⭐", "🔥", "🦊", "👻", "💎"];
      const allSuggestions = [
        ...new Set([...aiSuggestions, ...genericFallbacks]),
      ].slice(0, 12);
      const suggestionItems: vscode.QuickPickItem[] = allSuggestions.map(
        (e) => ({ label: e }),
      );

      const pick = await vscode.window.showQuickPick(suggestionItems, {
        title: i18n.emojiInvalidTitle,
        placeHolder: interpolate(i18n.emojiInvalidPlaceholder, {
          text: emojiValue,
        }),
        ignoreFocusOut: true,
      });
      if (!pick) return null;
      emojiValue = pick.label;
    }

    // ─── Step 5: Agent name ─────────────────────────────────────────
    const nameValue = await vscode.window.showInputBox({
      title: i18n.wizardNameTitle,
      prompt: i18n.wizardNamePrompt,
      placeHolder: i18n.wizardNamePlaceholder,
      value: PRIMARY_AGENT_NAME,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "Name cannot be empty";
        if (trimmed.length > 40) return "Name too long (max 40 characters)";
        return null;
      },
    });
    if (nameValue === undefined) return null;
    const agentName = nameValue.trim() || PRIMARY_AGENT_NAME;

    const identity: AgentIdentity = {
      name: agentName,
      creature: creatureValue,
      vibe: vibeValue,
      emoji: emojiValue,
      theme: `${vibeValue} ${creatureValue.toLowerCase()}`,
      language: langPick.label,
    };

    this.saveIdentity(identity);
    vscode.window.showInformationMessage(
      interpolate(i18n.wizardIdentityConfigured, {
        emoji: identity.emoji,
        name: identity.name,
        creature: identity.creature,
      }),
    );
    return identity;
  }

  // ─── Soul wizard ─────────────────────────────────────────────────

  async configureSoul(): Promise<AgentSoul | null> {
    this.log("Starting soul configuration...");
    const i18n = getBootstrapStrings(this.loadIdentity()?.language);

    const toneItems: vscode.QuickPickItem[] = i18n.soulToneItems;
    const tonePick = await vscode.window.showQuickPick(toneItems, {
      title: i18n.soulToneTitle,
      placeHolder: i18n.soulTonePlaceholder,
      ignoreFocusOut: true,
    });
    if (!tonePick) return null;

    const approachItems: vscode.QuickPickItem[] = i18n.soulApproachItems;
    const approachPick = await vscode.window.showQuickPick(approachItems, {
      title: i18n.soulApproachTitle,
      placeHolder: i18n.soulApproachPlaceholder,
      ignoreFocusOut: true,
    });
    if (!approachPick) return null;

    const customRules = await vscode.window.showInputBox({
      title: i18n.soulCustomRulesTitle,
      prompt: i18n.soulCustomRulesPrompt,
      placeHolder: i18n.soulCustomRulesPlaceholder,
      ignoreFocusOut: true,
    });
    if (customRules === undefined) return null;

    const identity = this.loadIdentity();
    const essence = this.extractProjectEssence();
    const existingSoul = this.loadSoul();

    const lore =
      existingSoul?.lore && existingSoul.lore.length > 0
        ? existingSoul.lore
        : this.buildAutoLore(
            identity,
            tonePick.label,
            approachPick.label,
            essence,
          );
    const topics =
      existingSoul?.topics && existingSoul.topics.length > 0
        ? existingSoul.topics
        : this.buildAutoTopics(essence);
    const messageExamples =
      existingSoul?.messageExamples && existingSoul.messageExamples.length > 0
        ? existingSoul.messageExamples
        : this.buildAutoMessageExamples(identity);

    const soul: AgentSoul = {
      ...existingSoul,
      tone: tonePick.label,
      boundaries:
        existingSoul?.boundaries ||
        "- When in doubt, ask before acting.\n- Never send half-baked solutions.\n- Don't run destructive commands unless explicitly asked.",
      approach: approachPick.label,
      customRules: customRules || "",
      lore,
      topics,
      messageExamples,
    };

    this.saveSoul(soul);
    vscode.window.showInformationMessage(i18n.soulConfigured);
    return soul;
  }

  // ─── User profile wizard ─────────────────────────────────────────

  async configureUser(): Promise<UserProfile | null> {
    this.log("Starting user profile configuration...");
    const i18n = getBootstrapStrings(this.loadIdentity()?.language);

    const name = await vscode.window.showInputBox({
      title: i18n.userNameTitle,
      prompt: i18n.userNamePrompt,
      placeHolder: i18n.userNamePlaceholder,
      ignoreFocusOut: true,
    });
    if (!name) return null;

    const address = await vscode.window.showInputBox({
      title: i18n.userAddressTitle,
      prompt: i18n.userAddressPrompt,
      placeHolder: name,
      value: name,
      ignoreFocusOut: true,
    });
    if (address === undefined) return null;

    const timezone = await vscode.window.showInputBox({
      title: i18n.userTimezoneTitle,
      prompt: i18n.userTimezonePrompt,
      placeHolder: i18n.userTimezonePlaceholder,
      ignoreFocusOut: true,
    });

    const notes = await vscode.window.showInputBox({
      title: i18n.userNotesTitle,
      prompt: i18n.userNotesPrompt,
      placeHolder: i18n.userNotesPlaceholder,
      ignoreFocusOut: true,
    });

    const user: UserProfile = {
      name,
      preferredAddress: address || name,
      timezone: timezone || "",
      notes: notes || "",
    };

    this.saveUser(user);
    vscode.window.showInformationMessage(
      interpolate(i18n.userSaved, { name: user.name }),
    );
    return user;
  }

  // ─── Programming preferences wizard ──────────────────────────────

  async configureProgrammingPrefs(): Promise<ProgrammingPrefs | null> {
    this.log("Starting programming preferences configuration...");
    const i18n = getBootstrapStrings(this.loadIdentity()?.language);

    const architecture = await vscode.window.showInputBox({
      title: i18n.prefsArchTitle,
      prompt: i18n.prefsArchPrompt,
      placeHolder: i18n.prefsArchPlaceholder,
      ignoreFocusOut: true,
    });
    if (architecture === undefined) return null;

    const codeStyle = await vscode.window.showInputBox({
      title: i18n.prefsStyleTitle,
      prompt: i18n.prefsStylePrompt,
      placeHolder: i18n.prefsStylePlaceholder,
      ignoreFocusOut: true,
    });
    if (codeStyle === undefined) return null;

    const testing = await vscode.window.showInputBox({
      title: i18n.prefsTestTitle,
      prompt: i18n.prefsTestPrompt,
      placeHolder: i18n.prefsTestPlaceholder,
      ignoreFocusOut: true,
    });
    if (testing === undefined) return null;

    const gitWorkflow = await vscode.window.showInputBox({
      title: i18n.prefsGitTitle,
      prompt: i18n.prefsGitPrompt,
      placeHolder: i18n.prefsGitPlaceholder,
      ignoreFocusOut: true,
    });
    if (gitWorkflow === undefined) return null;

    const codeReview = await vscode.window.showInputBox({
      title: i18n.prefsReviewTitle,
      prompt: i18n.prefsReviewPrompt,
      placeHolder: i18n.prefsReviewPlaceholder,
      ignoreFocusOut: true,
    });
    if (codeReview === undefined) return null;

    const documentation = await vscode.window.showInputBox({
      title: i18n.prefsDocsTitle,
      prompt: i18n.prefsDocsPrompt,
      placeHolder: i18n.prefsDocsPlaceholder,
      ignoreFocusOut: true,
    });
    if (documentation === undefined) return null;

    const other = await vscode.window.showInputBox({
      title: i18n.prefsOtherTitle,
      prompt: i18n.prefsOtherPrompt,
      placeHolder: i18n.prefsOtherPlaceholder,
      ignoreFocusOut: true,
    });

    const prefs: ProgrammingPrefs = {
      architecture: architecture || "",
      codeStyle: codeStyle || "",
      testing: testing || "",
      gitWorkflow: gitWorkflow || "",
      codeReview: codeReview || "",
      documentation: documentation || "",
      other: other || "",
    };

    this.saveProgrammingPrefs(prefs);
    vscode.window.showInformationMessage(i18n.prefsSaved);
    return prefs;
  }

  // ─── Full bootstrap flow ─────────────────────────────────────────

  async runFullSetup(): Promise<{
    identity: AgentIdentity;
    soul: AgentSoul;
    user: UserProfile;
  } | null> {
    const identity = await this.configureInteractive();
    if (!identity) return null;

    const soul = await this.configureSoul();
    if (!soul) return null;

    const user = await this.configureUser();
    if (!user) return null;

    return { identity, soul, user };
  }

  // ─── Open files ──────────────────────────────────────────────────

  async openIdentityFile(): Promise<void> {
    await this.openOrCreateFile(IDENTITY_FILE, "Identity", () => {
      this.saveIdentity({
        name: "Brain",
        creature: "AI assistant",
        vibe: "balanced",
        emoji: "🧠",
        theme: "",
        language: "English",
      });
    });
  }

  async openSoulFile(): Promise<void> {
    await this.openOrCreateFile(SOUL_FILE, "Soul", () => {
      const identity = this.loadIdentity() ?? {
        name: PRIMARY_AGENT_NAME,
        creature: "AI assistant",
        vibe: "balanced",
        emoji: "🧠",
        theme: "",
        language: detectVSCodeLanguage(),
      };
      const essence = this.extractProjectEssence();
      this.saveSoul({
        tone: "Be the assistant you'd actually want to talk to.",
        boundaries: "",
        approach: "Balanced",
        customRules: "",
        lore: this.buildAutoLore(
          identity,
          "Be the assistant you'd actually want to talk to.",
          "Balanced",
          essence,
        ),
        topics: this.buildAutoTopics(essence),
        messageExamples: this.buildAutoMessageExamples(identity),
      });
    });
  }

  async openUserFile(): Promise<void> {
    await this.openOrCreateFile(USER_FILE, "User Profile", () => {
      this.saveUser({
        name: "",
        preferredAddress: "",
        timezone: "",
        notes: "",
      });
    });
  }

  async openProgrammingPrefsFile(): Promise<void> {
    await this.openOrCreateFile(
      PROGRAMMING_PREFS_FILE,
      "Programming Preferences",
      () => {
        this.saveProgrammingPrefs({
          architecture: "",
          codeStyle: "",
          testing: "",
          gitWorkflow: "",
          codeReview: "",
          documentation: "",
          other: "",
        });
      },
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  readSoulRaw(): string | null {
    const soulPath = path.join(this.memoryPath, SOUL_FILE);
    if (!fs.existsSync(soulPath)) return null;
    return fs.readFileSync(soulPath, "utf-8");
  }

  async validateSoulConsistency(): Promise<void> {
    const raw = this.readSoulRaw();
    if (!raw) {
      vscode.window.showWarningMessage(
        "No soul file found. Run 'Initialize Project Memory' first.",
      );
      return;
    }

    const soul = this.loadSoul();
    if (!soul) {
      vscode.window.showWarningMessage("Could not parse soul file.");
      return;
    }

    // Collect soul elements for audit
    const elements: string[] = [];
    if (soul.tone) elements.push(`Tone: ${soul.tone}`);
    if (soul.quirks?.length) elements.push(`Quirks: ${soul.quirks.join(", ")}`);
    if (soul.catchphrases) {
      const phrases: string[] = [];
      if (soul.catchphrases.success) phrases.push(...soul.catchphrases.success);
      if (soul.catchphrases.complexity)
        phrases.push(...soul.catchphrases.complexity);
      if (soul.catchphrases.warnings)
        phrases.push(...soul.catchphrases.warnings);
      if (phrases.length) elements.push(`Catchphrases: ${phrases.join("; ")}`);
    }
    if (soul.lore?.length)
      elements.push(`Lore: ${soul.lore.slice(0, 3).join(" | ")}`);
    if (soul.topics?.length)
      elements.push(`Topics: ${soul.topics.slice(0, 5).join(", ")}`);
    if (soul.messageExamples?.length) {
      const exStr = soul.messageExamples
        .slice(0, 2)
        .map((e) => `"${e.user}" → "${e.agent}"`)
        .join("; ");
      elements.push(`Example exchanges: ${exStr}`);
    }

    if (elements.length < 2) {
      vscode.window.showInformationMessage(
        "Soul file has too few elements to validate consistency.",
      );
      return;
    }

    // Send to LLM for consistency audit
    const auditPrompt = `You are a tone consistency auditor for an AI agent's personality configuration.
Below are the personality elements. Evaluate if they are internally consistent.
Return ONLY valid JSON: {"consistent": boolean, "score": number (0-100), "issues": string[], "suggestion": string}

Elements:
${elements.join("\n")}`;

    try {
      const models = await vscode.lm.selectChatModels({
        vendor: "copilot",
        family: "gpt-4o-mini",
      });
      let model = models[0];
      if (!model) {
        // Fallback to any copilot model
        const fallback = await vscode.lm.selectChatModels({
          vendor: "copilot",
        });
        model = fallback[0];
      }
      if (!model) {
        vscode.window.showErrorMessage(
          "No Copilot model available for soul validation.",
        );
        return;
      }

      const cts = new vscode.CancellationTokenSource();
      setTimeout(() => cts.cancel(), 30000);

      const messages = [vscode.LanguageModelChatMessage.User(auditPrompt)];
      const response = await model.sendRequest(messages, {}, cts.token);

      let fullText = "";
      for await (const chunk of response.text) {
        fullText += chunk;
      }

      // Parse JSON from response
      const jsonMatch = fullText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        vscode.window.showWarningMessage(
          "Could not parse validation response.",
        );
        return;
      }

      const result = JSON.parse(jsonMatch[0]) as {
        consistent: boolean;
        score: number;
        issues: string[];
        suggestion: string;
      };

      if (result.score >= 80) {
        vscode.window.showInformationMessage(
          `✅ Soul consistency: ${result.score}/100 — ${result.suggestion || "Looking good!"}`,
        );
      } else {
        const action = await vscode.window.showWarningMessage(
          `⚠️ Soul consistency: ${result.score}/100 — ${result.issues?.join("; ") || "Some inconsistencies found"}`,
          "Open Soul File",
          "Dismiss",
        );
        if (action === "Open Soul File") {
          await this.openSoulFile();
        }
      }
      this.log(
        `Soul validation: score=${result.score}, consistent=${result.consistent}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Soul validation failed: ${msg}`);
      this.log(`Soul validation error: ${msg}`);
    }
  }

  private ensureMemoryDir(): void {
    if (!fs.existsSync(this.memoryPath)) {
      fs.mkdirSync(this.memoryPath, { recursive: true });
    }
  }

  private async openOrCreateFile(
    filename: string,
    label: string,
    createDefault: () => void,
  ): Promise<void> {
    const filePath = path.join(this.memoryPath, filename);

    if (!fs.existsSync(filePath)) {
      const action = await vscode.window.showWarningMessage(
        `No ${label} file found. Create one?`,
        "Create with defaults",
        "Cancel",
      );
      if (action === "Create with defaults") {
        createDefault();
      } else {
        return;
      }
    }

    this.invalidateCache();
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(filePath),
    );
  }
}
