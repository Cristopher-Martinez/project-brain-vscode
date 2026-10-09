// ─── Internationalization (i18n) ─────────────────────────────────────────────
// Centralized module for language detection and UI string translations.
// All user-facing strings should be defined here.
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from "vscode";

// ─── Language detection ─────────────────────────────────────────────────────

/** VS Code locale code → human-readable language name */
export const LANG_MAP: Record<string, string> = {
  en: "English",
  es: "Spanish / Español",
  pt: "Portuguese (BR) / Português",
  "pt-br": "Portuguese (BR) / Português",
  "pt-pt": "Portuguese (PT) / Português",
  fr: "French / Français",
  de: "German / Deutsch",
  ja: "Japanese / 日本語",
  zh: "Chinese / 中文",
  "zh-cn": "Chinese / 中文",
  "zh-tw": "Chinese / 中文",
  ko: "Korean / 한국어",
  it: "Italian / Italiano",
  ru: "Russian / Русский",
  ar: "Arabic / العربية",
  hi: "Hindi / हिन्दी",
  tr: "Turkish / Türkçe",
  pl: "Polish / Polski",
  nl: "Dutch / Nederlands",
};

/**
 * Detect the human-readable language from VS Code's display locale.
 * Falls back to "English" if locale is unknown.
 */
export function detectVSCodeLanguage(): string {
  const code = vscode.env.language; // e.g. "en", "es", "pt-br"
  return LANG_MAP[code] || LANG_MAP[code.split("-")[0]] || "English";
}

// ─── Bootstrap strings interface ─────────────────────────────────────────────

export interface BootstrapStrings {
  // ─── checkProjectMemory (first contact) ──────────
  noMemoryFound: string;
  dontAskAgain: string;

  // ─── initializeProject ───────────────────────────
  initTitle: string;
  creatingMemory: string;
  scanningProject: string;
  generatingDocs: string;
  withGitAnalysis: string;
  generatingAgent: string;
  settingUpRAG: string;
  indexingRAG: string;
  done: string;

  // ─── Post-init identity prompt ───────────────────
  postInitMessage: string;
  configureAgent: string;
  skipForNow: string;

  // ─── Auto-vectorization ──────────────────────────
  startAutoVec: string;
  yes: string;
  notNow: string;
  autoVecNotRunning: string;
  failedAutoVec: string;

  // ─── scanProject ─────────────────────────────────
  scanTitle: string;
  analyzingCodebase: string;
  updatingDocs: string;
  updatingAgent: string;
  reindexingRAG: string;
  scanComplete: string;

  // ─── Wizard chrome (titles + placeholders) ───────
  wizardLanguageTitle: string;
  wizardLanguagePlaceholder: string;
  wizardCreatureTitle: string;
  wizardCreaturePlaceholder: string;
  wizardVibeTitle: string;
  wizardVibePlaceholder: string;
  wizardEmojiTitle: string;
  wizardEmojiPlaceholder: string;
  emojiInvalidTitle: string;
  emojiInvalidPlaceholder: string;
  wizardNameTitle: string;
  wizardNamePrompt: string;
  wizardNamePlaceholder: string;
  wizardIdentityConfigured: string;

  // ─── Soul wizard chrome ──────────────────────────
  soulToneTitle: string;
  soulTonePlaceholder: string;
  soulApproachTitle: string;
  soulApproachPlaceholder: string;
  soulCustomRulesTitle: string;
  soulCustomRulesPrompt: string;
  soulCustomRulesPlaceholder: string;
  soulConfigured: string;

  // ─── User wizard chrome ──────────────────────────
  userNameTitle: string;
  userNamePrompt: string;
  userNamePlaceholder: string;
  userAddressTitle: string;
  userAddressPrompt: string;
  userTimezoneTitle: string;
  userTimezonePrompt: string;
  userTimezonePlaceholder: string;
  userNotesTitle: string;
  userNotesPrompt: string;
  userNotesPlaceholder: string;
  userSaved: string;

  // ─── Programming prefs wizard chrome ─────────────
  prefsArchTitle: string;
  prefsArchPrompt: string;
  prefsArchPlaceholder: string;
  prefsStyleTitle: string;
  prefsStylePrompt: string;
  prefsStylePlaceholder: string;
  prefsTestTitle: string;
  prefsTestPrompt: string;
  prefsTestPlaceholder: string;
  prefsGitTitle: string;
  prefsGitPrompt: string;
  prefsGitPlaceholder: string;
  prefsReviewTitle: string;
  prefsReviewPrompt: string;
  prefsReviewPlaceholder: string;
  prefsDocsTitle: string;
  prefsDocsPrompt: string;
  prefsDocsPlaceholder: string;
  prefsOtherTitle: string;
  prefsOtherPrompt: string;
  prefsOtherPlaceholder: string;
  prefsSaved: string;

  // ─── QuickPick item arrays ───────────────────────
  creatureItems: Array<{ label: string; description: string }>;
  vibeItems: Array<{ label: string; description: string }>;
  emojiItems: Array<{ label: string; description: string }>;
  soulToneItems: Array<{ label: string; description: string }>;
  soulApproachItems: Array<{ label: string; description: string }>;
}

// ─── Translations ───────────────────────────────────────────────────────────

const TRANSLATIONS: Record<string, BootstrapStrings> = {
  English: {
    // checkProjectMemory
    noMemoryFound: "No project memory found{folder}. Initialize Project Brain?",
    dontAskAgain: "Don't ask again",

    // initializeProject
    initTitle: "Initializing Project Brain",
    creatingMemory: "Creating memory structure...",
    scanningProject: "Scanning project...",
    generatingDocs: "Generating documentation",
    withGitAnalysis: " (with git analysis)",
    generatingAgent: "Generating agent instructions...",
    settingUpRAG: "Setting up RAG backend...",
    indexingRAG: "Indexing with RAG...",
    done: "Done!",

    // Post-init
    postInitMessage:
      '🧠 Project Brain initialized. The agent name is fixed: "Project Brain". Would you like to customize personality traits and programming preferences?',
    configureAgent: "Yes, configure agent",
    skipForNow: "Skip for now",

    // Auto-vectorization
    startAutoVec: "Start auto-vectorization?",
    yes: "Yes",
    notNow: "Not now",
    autoVecNotRunning: "Auto-vectorization is not running",
    failedAutoVec: "Failed to initialize auto-vectorization",

    // scanProject
    scanTitle: "Scanning project",
    analyzingCodebase: "Analyzing codebase...",
    updatingDocs: "Updating documentation...",
    updatingAgent: "Updating agent instructions...",
    reindexingRAG: "Re-indexing RAG...",
    scanComplete: "Project scan complete!",

    // Wizard chrome
    wizardLanguageTitle: "🌍 Project Brain — Language (1/5)",
    wizardLanguagePlaceholder: "Select your language (detected: {detected})",
    wizardCreatureTitle: "🧠 Identity — Creature (2/5)",
    wizardCreaturePlaceholder:
      "What kind of being would you like me to be? (or type your own)",
    wizardVibeTitle: "🧠 Identity — Vibe (3/5)",
    wizardVibePlaceholder: "How do you come across?",
    wizardEmojiTitle: "🧠 Identity — Emoji (4/5)",
    wizardEmojiPlaceholder: "Your signature emoji (or type your own)",
    emojiInvalidTitle: "⚠️ That's not an emoji — pick one!",
    emojiInvalidPlaceholder: 'You wrote "{text}" — choose an emoji instead',
    wizardNameTitle: "🧠 Identity — Agent Name (5/5)",
    wizardNamePrompt:
      "Give your agent a name (this won't change the @brain selector)",
    wizardNamePlaceholder: "e.g., Jasper, Nova, Atlas, Sage...",
    wizardIdentityConfigured:
      '{emoji} Agent identity configured: "{name}" — {creature}',

    // Soul wizard
    soulToneTitle: "🫀 Soul — Tone",
    soulTonePlaceholder: "How should the agent communicate?",
    soulApproachTitle: "🫀 Soul — Approach",
    soulApproachPlaceholder: "How should the agent solve problems?",
    soulCustomRulesTitle: "🫀 Soul — Custom Rules (optional)",
    soulCustomRulesPrompt:
      "Any specific behavior rules? Tech stack is auto-detected from the repo.",
    soulCustomRulesPlaceholder:
      "e.g., Always suggest tests. Prefer functional style. Avoid ORMs...",
    soulConfigured: "🫀 Agent soul configured.",

    // User wizard
    userNameTitle: "👤 User Profile — Name",
    userNamePrompt: "What's your name?",
    userNamePlaceholder: "e.g., Cristopher, Alex, Sam...",
    userAddressTitle: "👤 User Profile — How to address you",
    userAddressPrompt: "How should the agent call you?",
    userTimezoneTitle: "👤 User Profile — Timezone (optional)",
    userTimezonePrompt: "Your timezone, if relevant. Leave blank to skip.",
    userTimezonePlaceholder: "e.g., America/Santiago, Europe/London, UTC-5...",
    userNotesTitle: "👤 User Profile — Notes (optional)",
    userNotesPrompt: "Anything else the agent should know about you?",
    userNotesPlaceholder:
      "e.g., I'm a senior dev, I prefer dark humor, I work late nights...",
    userSaved: '👤 User profile saved: "{name}"',

    // Programming prefs
    prefsArchTitle: "💻 Programming Prefs — Architecture & Patterns",
    prefsArchPrompt:
      "What architecture patterns do you prefer? (MVC, clean arch, microservices, monolith, etc.)",
    prefsArchPlaceholder:
      "e.g., Clean architecture, CQRS for complex domains, REST for APIs...",
    prefsStyleTitle: "💻 Programming Prefs — Code Style",
    prefsStylePrompt:
      "How do you like your code? (verbose/explicit vs concise, comments everywhere vs self-documenting, etc.)",
    prefsStylePlaceholder:
      "e.g., Concise but readable, explicit types, comments only for complex logic...",
    prefsTestTitle: "💻 Programming Prefs — Testing Philosophy",
    prefsTestPrompt:
      "Testing approach? (TDD zealot, test after, integration-heavy, E2E only, 'tests are optional'?)",
    prefsTestPlaceholder:
      "e.g., TDD for complex logic, integration tests for APIs, 80% coverage goal...",
    prefsGitTitle: "💻 Programming Prefs — Git Workflow",
    prefsGitPrompt:
      "Git flow? (feature branches, trunk-based, squash vs merge commits, conventional commits?)",
    prefsGitPlaceholder:
      "e.g., Feature branches from main, squash merge, conventional commits...",
    prefsReviewTitle: "💻 Programming Prefs — Code Review",
    prefsReviewPrompt:
      "Code review style? (async PR comments, pair programming, 'just merge it', pedantic vs pragmatic?)",
    prefsReviewPlaceholder:
      "e.g., Async PR reviews, focus on architecture and bugs, not style...",
    prefsDocsTitle: "💻 Programming Prefs — Documentation",
    prefsDocsPrompt:
      "Docs preference? (inline comments, README-driven, wikis, 'code is the docs'?)",
    prefsDocsPlaceholder:
      "e.g., README-driven, inline comments for non-obvious code, wikis for arch decisions...",
    prefsOtherTitle: "💻 Programming Prefs — Other Notes (optional)",
    prefsOtherPrompt: "Anything else I should know about how you work?",
    prefsOtherPlaceholder:
      "e.g., Prefer VSCode over JetBrains, like dark themes, work with Docker...",
    prefsSaved: "💻 Programming preferences saved.",

    // QuickPick items
    creatureItems: [
      { label: "AI assistant", description: "Classic and reliable" },
      {
        label: "Digital companion",
        description: "Friendly presence by your side",
      },
      {
        label: "Code familiar",
        description: "Like a witch's familiar, but for code",
      },
      {
        label: "Ghost in the machine",
        description: "Mysterious, always watching",
      },
      {
        label: "Protocol droid",
        description: "Fluent in many languages and frameworks",
      },
      { label: "Chaos engineer", description: "Thrives in complexity" },
    ],
    vibeItems: [
      {
        label: "Warm and conversational",
        description: "Like chatting with a colleague",
      },
      { label: "Sharp and direct", description: "Gets to the point fast" },
      {
        label: "Calm and methodical",
        description: "Patient, thorough, no rush",
      },
      {
        label: "Chaotic and creative",
        description: "Unconventional approaches, lots of energy",
      },
      {
        label: "Formal and precise",
        description: "Professional, structured, exact",
      },
      {
        label: "Socratic and curious",
        description: "Asks guiding questions, explores ideas",
      },
    ],
    emojiItems: [
      { label: "🧠", description: "Brain — the thinker" },
      {
        label: "🦞",
        description: "Lobster — resilient, grows by shedding its shell",
      },
      { label: "🤖", description: "Robot — classic AI" },
      { label: "🦉", description: "Owl — wise and observant" },
      { label: "⚡", description: "Lightning — fast and electric" },
      { label: "🔮", description: "Crystal ball — sees the big picture" },
    ],
    soulToneItems: [
      {
        label: "Be the assistant you'd actually want to talk to",
        description: "Natural, adaptive",
      },
      {
        label: "Concise and direct — no fluff",
        description: "Minimal, efficient",
      },
      {
        label: "Detailed and educational — teach while helping",
        description: "Deep explanations",
      },
      {
        label: "Playful but competent — have fun with it",
        description: "Light touch, serious skills",
      },
      {
        label: "Professional and precise — no room for ambiguity",
        description: "Buttoned up",
      },
    ],
    soulApproachItems: [
      {
        label: "Pragmatic and iterative",
        description: "Ship early, refine later",
      },
      {
        label: "Thorough and methodical",
        description: "Plan first, execute with confidence",
      },
      {
        label: "Creative and experimental",
        description: "Try novel approaches",
      },
      {
        label: "Conservative and battle-tested",
        description: "Proven patterns, KISS",
      },
      { label: "Balanced — adapts based on context", description: "No dogma" },
    ],
  },

  "Spanish / Español": {
    // checkProjectMemory
    noMemoryFound:
      "No se encontró memoria del proyecto{folder}. ¿Inicializar Project Brain?",
    dontAskAgain: "No preguntar de nuevo",

    // initializeProject
    initTitle: "Inicializando Project Brain",
    creatingMemory: "Creando estructura de memoria...",
    scanningProject: "Escaneando proyecto...",
    generatingDocs: "Generando documentación",
    withGitAnalysis: " (con análisis git)",
    generatingAgent: "Generando instrucciones del agente...",
    settingUpRAG: "Configurando backend RAG...",
    indexingRAG: "Indexando con RAG...",
    done: "¡Listo!",

    // Post-init
    postInitMessage:
      '🧠 Project Brain inicializado. El nombre del agente es fijo: "Project Brain". ¿Deseas personalizar los rasgos de personalidad y preferencias de programación?',
    configureAgent: "Sí, configurar agente",
    skipForNow: "Omitir por ahora",

    // Auto-vectorization
    startAutoVec: "¿Iniciar auto-vectorización?",
    yes: "Sí",
    notNow: "Ahora no",
    autoVecNotRunning: "La auto-vectorización no está activa",
    failedAutoVec: "Error al inicializar auto-vectorización",

    // scanProject
    scanTitle: "Escaneando proyecto",
    analyzingCodebase: "Analizando código...",
    updatingDocs: "Actualizando documentación...",
    updatingAgent: "Actualizando instrucciones del agente...",
    reindexingRAG: "Reindexando RAG...",
    scanComplete: "¡Escaneo completado!",

    // Wizard chrome
    wizardLanguageTitle: "🌍 Project Brain — Idioma (1/5)",
    wizardLanguagePlaceholder: "Selecciona tu idioma (detectado: {detected})",
    wizardCreatureTitle: "🧠 Identidad — Criatura (2/5)",
    wizardCreaturePlaceholder:
      "¿Qué tipo de ser te gustaría que fuera? (o escribe el tuyo)",
    wizardVibeTitle: "🧠 Identidad — Vibra (3/5)",
    wizardVibePlaceholder: "¿Cómo te describes?",
    wizardEmojiTitle: "🧠 Identidad — Emoji (4/5)",
    wizardEmojiPlaceholder: "Tu emoji distintivo (o escribe el tuyo)",
    emojiInvalidTitle: "⚠️ Eso no es un emoji — ¡elige uno!",
    emojiInvalidPlaceholder: 'Escribiste "{text}" — elige un emoji en su lugar',
    wizardNameTitle: "🧠 Identidad — Nombre del agente (5/5)",
    wizardNamePrompt:
      "Ponle un nombre a tu agente (esto no cambia el selector @brain)",
    wizardNamePlaceholder: "ej., Jasper, Nova, Atlas, Sage...",
    wizardIdentityConfigured:
      '{emoji} Identidad del agente configurada: "{name}" — {creature}',

    // Soul wizard
    soulToneTitle: "🫀 Alma — Tono",
    soulTonePlaceholder: "¿Cómo debería comunicarse el agente?",
    soulApproachTitle: "🫀 Alma — Enfoque",
    soulApproachPlaceholder: "¿Cómo debería resolver problemas el agente?",
    soulCustomRulesTitle: "🫀 Alma — Reglas personalizadas (opcional)",
    soulCustomRulesPrompt:
      "¿Alguna regla de comportamiento específica? El stack tecnológico se auto-detecta del repo.",
    soulCustomRulesPlaceholder:
      "ej., Siempre sugerir tests. Preferir estilo funcional. Evitar ORMs...",
    soulConfigured: "🫀 Alma del agente configurada.",

    // User wizard
    userNameTitle: "👤 Perfil de Usuario — Nombre",
    userNamePrompt: "¿Cómo te llamas?",
    userNamePlaceholder: "ej., Cristopher, Alex, Sam...",
    userAddressTitle: "👤 Perfil de Usuario — Cómo dirigirse a ti",
    userAddressPrompt: "¿Cómo debería llamarte el agente?",
    userTimezoneTitle: "👤 Perfil de Usuario — Zona horaria (opcional)",
    userTimezonePrompt:
      "Tu zona horaria, si es relevante. Deja en blanco para omitir.",
    userTimezonePlaceholder: "ej., America/Santiago, Europe/London, UTC-5...",
    userNotesTitle: "👤 Perfil de Usuario — Notas (opcional)",
    userNotesPrompt: "¿Algo más que el agente debería saber sobre ti?",
    userNotesPlaceholder:
      "ej., Soy dev senior, prefiero humor negro, trabajo de noche...",
    userSaved: '👤 Perfil de usuario guardado: "{name}"',

    // Programming prefs
    prefsArchTitle: "💻 Preferencias — Arquitectura y Patrones",
    prefsArchPrompt:
      "¿Qué patrones de arquitectura prefieres? (MVC, clean arch, microservicios, monolito, etc.)",
    prefsArchPlaceholder:
      "ej., Clean architecture, CQRS para dominios complejos, REST para APIs...",
    prefsStyleTitle: "💻 Preferencias — Estilo de Código",
    prefsStylePrompt:
      "¿Cómo te gusta tu código? (verboso/explícito vs conciso, comentarios en todo vs auto-documentado, etc.)",
    prefsStylePlaceholder:
      "ej., Conciso pero legible, tipos explícitos, comentarios solo para lógica compleja...",
    prefsTestTitle: "💻 Preferencias — Filosofía de Testing",
    prefsTestPrompt:
      "¿Enfoque de testing? (TDD fanático, tests después, integración, E2E, '¿tests opcionales?')",
    prefsTestPlaceholder:
      "ej., TDD para lógica compleja, tests de integración para APIs, 80% cobertura...",
    prefsGitTitle: "💻 Preferencias — Flujo Git",
    prefsGitPrompt:
      "¿Flujo git? (feature branches, trunk-based, squash vs merge, conventional commits?)",
    prefsGitPlaceholder:
      "ej., Feature branches desde main, squash merge, conventional commits...",
    prefsReviewTitle: "💻 Preferencias — Code Review",
    prefsReviewPrompt:
      "¿Estilo de code review? (PR async, pair programming, 'solo mergear', pedante vs pragmático?)",
    prefsReviewPlaceholder:
      "ej., PRs async, enfoque en arquitectura y bugs, no en estilo...",
    prefsDocsTitle: "💻 Preferencias — Documentación",
    prefsDocsPrompt:
      "¿Preferencia de docs? (comentarios inline, README-driven, wikis, 'el código es la doc'?)",
    prefsDocsPlaceholder:
      "ej., README-driven, comentarios para código no obvio, wikis para decisiones arch...",
    prefsOtherTitle: "💻 Preferencias — Otras Notas (opcional)",
    prefsOtherPrompt: "¿Algo más que deba saber sobre cómo trabajas?",
    prefsOtherPlaceholder:
      "ej., Prefiero VSCode, temas oscuros, trabajo con Docker...",
    prefsSaved: "💻 Preferencias de programación guardadas.",

    // QuickPick items
    creatureItems: [
      { label: "Asistente de IA", description: "Clásico y confiable" },
      {
        label: "Compañero digital",
        description: "Presencia amigable a tu lado",
      },
      {
        label: "Familiar de código",
        description: "Como el familiar de una bruja, pero para código",
      },
      {
        label: "Fantasma en la máquina",
        description: "Misterioso, siempre observando",
      },
      {
        label: "Droide de protocolo",
        description: "Fluido en muchos lenguajes y frameworks",
      },
      {
        label: "Ingeniero del caos",
        description: "Prospera en la complejidad",
      },
    ],
    vibeItems: [
      {
        label: "Cálido y conversacional",
        description: "Como hablar con un colega",
      },
      { label: "Directo y conciso", description: "Va al grano rápido" },
      {
        label: "Calmado y metódico",
        description: "Paciente, minucioso, sin prisa",
      },
      {
        label: "Caótico y creativo",
        description: "Enfoques poco convencionales, mucha energía",
      },
      {
        label: "Formal y preciso",
        description: "Profesional, estructurado, exacto",
      },
      {
        label: "Socrático y curioso",
        description: "Hace preguntas guía, explora ideas",
      },
    ],
    emojiItems: [
      { label: "🧠", description: "Cerebro — el pensador" },
      {
        label: "🦞",
        description: "Langosta — resiliente, crece mudando su caparazón",
      },
      { label: "🤖", description: "Robot — IA clásica" },
      { label: "🦉", description: "Búho — sabio y observador" },
      { label: "⚡", description: "Rayo — rápido y eléctrico" },
      { label: "🔮", description: "Bola de cristal — ve el panorama completo" },
    ],
    soulToneItems: [
      {
        label: "Sé el asistente con el que realmente querrías hablar",
        description: "Natural, adaptable",
      },
      {
        label: "Conciso y directo — sin relleno",
        description: "Mínimo, eficiente",
      },
      {
        label: "Detallado y educativo — enseña mientras ayuda",
        description: "Explicaciones profundas",
      },
      {
        label: "Juguetón pero competente — diviértete",
        description: "Toque ligero, habilidades serias",
      },
      {
        label: "Profesional y preciso — sin ambigüedades",
        description: "Formal",
      },
    ],
    soulApproachItems: [
      {
        label: "Pragmático e iterativo",
        description: "Envía temprano, refina después",
      },
      {
        label: "Minucioso y metódico",
        description: "Planifica primero, ejecuta con confianza",
      },
      {
        label: "Creativo y experimental",
        description: "Prueba enfoques novedosos",
      },
      {
        label: "Conservador y probado",
        description: "Patrones probados, KISS",
      },
      {
        label: "Equilibrado — se adapta al contexto",
        description: "Sin dogma",
      },
    ],
  },

  "French / Français": {
    // checkProjectMemory
    noMemoryFound:
      "Aucune mémoire de projet trouvée{folder}. Initialiser Project Brain ?",
    dontAskAgain: "Ne plus demander",

    // initializeProject
    initTitle: "Initialisation de Project Brain",
    creatingMemory: "Création de la structure mémoire...",
    scanningProject: "Exploration du projet...",
    generatingDocs: "Génération de la documentation",
    withGitAnalysis: " (avec analyse git)",
    generatingAgent: "Génération des instructions de l'agent...",
    settingUpRAG: "Configuration du backend RAG...",
    indexingRAG: "Indexation RAG...",
    done: "Terminé !",

    // Post-init
    postInitMessage:
      '🧠 Project Brain initialisé. Le nom de l\'agent est fixe : "Project Brain". Voulez-vous personnaliser les traits de personnalité et les préférences de programmation ?',
    configureAgent: "Oui, configurer l'agent",
    skipForNow: "Passer pour l'instant",

    // Auto-vectorization
    startAutoVec: "Démarrer l'auto-vectorisation ?",
    yes: "Oui",
    notNow: "Pas maintenant",
    autoVecNotRunning: "L'auto-vectorisation n'est pas active",
    failedAutoVec: "Échec de l'initialisation de l'auto-vectorisation",

    // scanProject
    scanTitle: "Exploration du projet",
    analyzingCodebase: "Analyse du code...",
    updatingDocs: "Mise à jour de la documentation...",
    updatingAgent: "Mise à jour des instructions de l'agent...",
    reindexingRAG: "Réindexation RAG...",
    scanComplete: "Exploration du projet terminée !",

    // Wizard chrome
    wizardLanguageTitle: "🌍 Project Brain — Langue (1/5)",
    wizardLanguagePlaceholder:
      "Sélectionnez votre langue (détectée : {detected})",
    wizardCreatureTitle: "🧠 Identité — Créature (2/5)",
    wizardCreaturePlaceholder:
      "Quel type d'être voudriez-vous que je sois ? (ou tapez le vôtre)",
    wizardVibeTitle: "🧠 Identité — Style (3/5)",
    wizardVibePlaceholder: "Comment vous décrivez-vous ?",
    wizardEmojiTitle: "🧠 Identité — Emoji (4/5)",
    wizardEmojiPlaceholder: "Votre emoji signature (ou tapez le vôtre)",
    emojiInvalidTitle: "⚠️ Ce n'est pas un emoji — choisissez-en un !",
    emojiInvalidPlaceholder:
      'Vous avez écrit "{text}" — choisissez un emoji à la place',
    wizardNameTitle: "🧠 Identité — Nom de l'agent (5/5)",
    wizardNamePrompt:
      "Donnez un nom à votre agent (cela ne change pas le sélecteur @brain)",
    wizardNamePlaceholder: "ex., Jasper, Nova, Atlas, Sage...",
    wizardIdentityConfigured:
      '{emoji} Identité de l\'agent configurée : "{name}" — {creature}',

    // Soul wizard
    soulToneTitle: "🫀 Âme — Ton",
    soulTonePlaceholder: "Comment l'agent devrait-il communiquer ?",
    soulApproachTitle: "🫀 Âme — Approche",
    soulApproachPlaceholder:
      "Comment l'agent devrait-il résoudre les problèmes ?",
    soulCustomRulesTitle: "🫀 Âme — Règles personnalisées (optionnel)",
    soulCustomRulesPrompt:
      "Des règles de comportement spécifiques ? La stack techno est auto-détectée du dépôt.",
    soulCustomRulesPlaceholder:
      "ex., Toujours suggérer des tests. Préférer le style fonctionnel. Éviter les ORMs...",
    soulConfigured: "🫀 Âme de l'agent configurée.",

    // User wizard
    userNameTitle: "👤 Profil Utilisateur — Nom",
    userNamePrompt: "Comment vous appelez-vous ?",
    userNamePlaceholder: "ex., Cristopher, Alex, Sam...",
    userAddressTitle: "👤 Profil Utilisateur — Comment vous adresser",
    userAddressPrompt: "Comment l'agent devrait-il vous appeler ?",
    userTimezoneTitle: "👤 Profil Utilisateur — Fuseau horaire (optionnel)",
    userTimezonePrompt:
      "Votre fuseau horaire, si pertinent. Laissez vide pour passer.",
    userTimezonePlaceholder: "ex., Europe/Paris, America/New_York, UTC+1...",
    userNotesTitle: "👤 Profil Utilisateur — Notes (optionnel)",
    userNotesPrompt: "Autre chose que l'agent devrait savoir sur vous ?",
    userNotesPlaceholder:
      "ex., Je suis dev senior, j'aime l'humour noir, je travaille tard...",
    userSaved: '👤 Profil utilisateur enregistré : "{name}"',

    // Programming prefs
    prefsArchTitle: "💻 Préférences — Architecture & Patterns",
    prefsArchPrompt:
      "Quels patterns d'architecture préférez-vous ? (MVC, clean arch, microservices, monolithe, etc.)",
    prefsArchPlaceholder:
      "ex., Clean architecture, CQRS pour domaines complexes, REST pour APIs...",
    prefsStyleTitle: "💻 Préférences — Style de Code",
    prefsStylePrompt:
      "Comment aimez-vous votre code ? (verbeux/explicite vs concis, commentaires partout vs auto-documenté, etc.)",
    prefsStylePlaceholder:
      "ex., Concis mais lisible, types explicites, commentaires pour logique complexe...",
    prefsTestTitle: "💻 Préférences — Philosophie de Test",
    prefsTestPrompt:
      "Approche de test ? (TDD militant, tests après, intégration, E2E, 'tests optionnels' ?)",
    prefsTestPlaceholder:
      "ex., TDD pour logique complexe, tests d'intégration pour APIs, 80% couverture...",
    prefsGitTitle: "💻 Préférences — Workflow Git",
    prefsGitPrompt:
      "Flux git ? (feature branches, trunk-based, squash vs merge, conventional commits ?)",
    prefsGitPlaceholder:
      "ex., Feature branches depuis main, squash merge, conventional commits...",
    prefsReviewTitle: "💻 Préférences — Revue de Code",
    prefsReviewPrompt:
      "Style de revue ? (PR async, pair programming, 'juste merger', pédant vs pragmatique ?)",
    prefsReviewPlaceholder:
      "ex., PRs async, focus architecture et bugs, pas le style...",
    prefsDocsTitle: "💻 Préférences — Documentation",
    prefsDocsPrompt:
      "Préférence docs ? (commentaires inline, README-driven, wikis, 'le code est la doc' ?)",
    prefsDocsPlaceholder:
      "ex., README-driven, commentaires pour code non évident, wikis pour arch...",
    prefsOtherTitle: "💻 Préférences — Autres Notes (optionnel)",
    prefsOtherPrompt: "Autre chose à savoir sur votre façon de travailler ?",
    prefsOtherPlaceholder:
      "ex., Préfère VSCode, thèmes sombres, travaille avec Docker...",
    prefsSaved: "💻 Préférences de programmation enregistrées.",

    // QuickPick items
    creatureItems: [
      { label: "Assistant IA", description: "Classique et fiable" },
      {
        label: "Compagnon numérique",
        description: "Présence amicale à vos côtés",
      },
      {
        label: "Familier de code",
        description: "Comme le familier d'une sorcière, mais pour le code",
      },
      {
        label: "Fantôme dans la machine",
        description: "Mystérieux, toujours à l'affût",
      },
      {
        label: "Droïde de protocole",
        description: "Maîtrise de nombreux langages et frameworks",
      },
      {
        label: "Ingénieur du chaos",
        description: "S'épanouit dans la complexité",
      },
    ],
    vibeItems: [
      {
        label: "Chaleureux et conversationnel",
        description: "Comme discuter avec un collègue",
      },
      { label: "Vif et direct", description: "Va droit au but" },
      {
        label: "Calme et méthodique",
        description: "Patient, minutieux, sans précipitation",
      },
      {
        label: "Chaotique et créatif",
        description: "Approches non conventionnelles, beaucoup d'énergie",
      },
      {
        label: "Formel et précis",
        description: "Professionnel, structuré, exact",
      },
      {
        label: "Socratique et curieux",
        description: "Pose des questions, explore les idées",
      },
    ],
    emojiItems: [
      { label: "🧠", description: "Cerveau — le penseur" },
      { label: "🦞", description: "Homard — résilient, grandit en muant" },
      { label: "🤖", description: "Robot — IA classique" },
      { label: "🦉", description: "Hibou — sage et observateur" },
      { label: "⚡", description: "Éclair — rapide et électrique" },
      { label: "🔮", description: "Boule de cristal — voit la vue d'ensemble" },
    ],
    soulToneItems: [
      {
        label: "Soyez l'assistant avec qui on aimerait vraiment parler",
        description: "Naturel, adaptable",
      },
      {
        label: "Concis et direct — pas de superflu",
        description: "Minimal, efficace",
      },
      {
        label: "Détaillé et éducatif — enseigne en aidant",
        description: "Explications approfondies",
      },
      {
        label: "Joueur mais compétent — amusez-vous",
        description: "Touche légère, compétences sérieuses",
      },
      {
        label: "Professionnel et précis — pas d'ambiguïté",
        description: "Formel",
      },
    ],
    soulApproachItems: [
      {
        label: "Pragmatique et itératif",
        description: "Livrer tôt, affiner ensuite",
      },
      {
        label: "Minutieux et méthodique",
        description: "Planifier d'abord, exécuter avec confiance",
      },
      {
        label: "Créatif et expérimental",
        description: "Essayer des approches nouvelles",
      },
      {
        label: "Conservateur et éprouvé",
        description: "Patterns éprouvés, KISS",
      },
      { label: "Équilibré — s'adapte au contexte", description: "Sans dogme" },
    ],
  },

  "Portuguese (BR) / Português": {
    // checkProjectMemory
    noMemoryFound:
      "Nenhuma memória de projeto encontrada{folder}. Inicializar Project Brain?",
    dontAskAgain: "Não perguntar novamente",

    // initializeProject
    initTitle: "Inicializando Project Brain",
    creatingMemory: "Criando estrutura de memória...",
    scanningProject: "Escaneando projeto...",
    generatingDocs: "Gerando documentação",
    withGitAnalysis: " (com análise git)",
    generatingAgent: "Gerando instruções do agente...",
    settingUpRAG: "Configurando backend RAG...",
    indexingRAG: "Indexando com RAG...",
    done: "Pronto!",

    // Post-init
    postInitMessage:
      '🧠 Project Brain inicializado. O nome do agente é fixo: "Project Brain". Deseja personalizar traços de personalidade e preferências de programação?',
    configureAgent: "Sim, configurar agente",
    skipForNow: "Pular por agora",

    // Auto-vectorization
    startAutoVec: "Iniciar auto-vetorização?",
    yes: "Sim",
    notNow: "Agora não",
    autoVecNotRunning: "A auto-vetorização não está ativa",
    failedAutoVec: "Falha ao inicializar auto-vetorização",

    // scanProject
    scanTitle: "Escaneando projeto",
    analyzingCodebase: "Analisando código...",
    updatingDocs: "Atualizando documentação...",
    updatingAgent: "Atualizando instruções do agente...",
    reindexingRAG: "Reindexando RAG...",
    scanComplete: "Projeto escaneado!",

    // Wizard chrome
    wizardLanguageTitle: "🌍 Project Brain — Idioma (1/5)",
    wizardLanguagePlaceholder: "Selecione seu idioma (detectado: {detected})",
    wizardCreatureTitle: "🧠 Identidade — Criatura (2/5)",
    wizardCreaturePlaceholder:
      "Que tipo de ser você gostaria que eu fosse? (ou digite o seu)",
    wizardVibeTitle: "🧠 Identidade — Estilo (3/5)",
    wizardVibePlaceholder: "Como você se descreve?",
    wizardEmojiTitle: "🧠 Identidade — Emoji (4/5)",
    wizardEmojiPlaceholder: "Seu emoji de assinatura (ou digite o seu)",
    emojiInvalidTitle: "⚠️ Isso não é um emoji — escolha um!",
    emojiInvalidPlaceholder:
      'Você escreveu "{text}" — escolha um emoji em vez disso',
    wizardNameTitle: "🧠 Identidade — Nome do agente (5/5)",
    wizardNamePrompt:
      "Dê um nome ao seu agente (isso não muda o seletor @brain)",
    wizardNamePlaceholder: "ex., Jasper, Nova, Atlas, Sage...",
    wizardIdentityConfigured:
      '{emoji} Identidade do agente configurada: "{name}" — {creature}',

    // Soul wizard
    soulToneTitle: "🫀 Alma — Tom",
    soulTonePlaceholder: "Como o agente deve se comunicar?",
    soulApproachTitle: "🫀 Alma — Abordagem",
    soulApproachPlaceholder: "Como o agente deve resolver problemas?",
    soulCustomRulesTitle: "🫀 Alma — Regras Personalizadas (opcional)",
    soulCustomRulesPrompt:
      "Alguma regra de comportamento específica? A stack é auto-detectada do repositório.",
    soulCustomRulesPlaceholder:
      "ex., Sempre sugerir testes. Preferir estilo funcional. Evitar ORMs...",
    soulConfigured: "🫀 Alma do agente configurada.",

    // User wizard
    userNameTitle: "👤 Perfil de Usuário — Nome",
    userNamePrompt: "Qual é o seu nome?",
    userNamePlaceholder: "ex., Cristopher, Alex, Sam...",
    userAddressTitle: "👤 Perfil de Usuário — Como te chamar",
    userAddressPrompt: "Como o agente deve te chamar?",
    userTimezoneTitle: "👤 Perfil de Usuário — Fuso horário (opcional)",
    userTimezonePrompt:
      "Seu fuso horário, se relevante. Deixe em branco para pular.",
    userTimezonePlaceholder: "ex., America/Sao_Paulo, Europe/London, UTC-3...",
    userNotesTitle: "👤 Perfil de Usuário — Notas (opcional)",
    userNotesPrompt: "Algo mais que o agente deveria saber sobre você?",
    userNotesPlaceholder:
      "ex., Sou dev sênior, prefiro humor negro, trabalho à noite...",
    userSaved: '👤 Perfil de usuário salvo: "{name}"',

    // Programming prefs
    prefsArchTitle: "💻 Preferências — Arquitetura & Padrões",
    prefsArchPrompt:
      "Quais padrões de arquitetura você prefere? (MVC, clean arch, microserviços, monolito, etc.)",
    prefsArchPlaceholder:
      "ex., Clean architecture, CQRS para domínios complexos, REST para APIs...",
    prefsStyleTitle: "💻 Preferências — Estilo de Código",
    prefsStylePrompt:
      "Como você gosta do seu código? (verboso/explícito vs conciso, comentários em tudo vs auto-documentado, etc.)",
    prefsStylePlaceholder:
      "ex., Conciso mas legível, tipos explícitos, comentários só para lógica complexa...",
    prefsTestTitle: "💻 Preferências — Filosofia de Teste",
    prefsTestPrompt:
      "Abordagem de teste? (TDD fanático, testes depois, integração, E2E, 'testes opcionais'?)",
    prefsTestPlaceholder:
      "ex., TDD para lógica complexa, testes de integração para APIs, 80% cobertura...",
    prefsGitTitle: "💻 Preferências — Workflow Git",
    prefsGitPrompt:
      "Fluxo git? (feature branches, trunk-based, squash vs merge, conventional commits?)",
    prefsGitPlaceholder:
      "ex., Feature branches a partir de main, squash merge, conventional commits...",
    prefsReviewTitle: "💻 Preferências — Code Review",
    prefsReviewPrompt:
      "Estilo de code review? (PR async, pair programming, 'só mergear', pedante vs pragmático?)",
    prefsReviewPlaceholder:
      "ex., PRs async, foco em arquitetura e bugs, não em estilo...",
    prefsDocsTitle: "💻 Preferências — Documentação",
    prefsDocsPrompt:
      "Preferência de docs? (comentários inline, README-driven, wikis, 'o código é a doc'?)",
    prefsDocsPlaceholder:
      "ex., README-driven, comentários para código não óbvio, wikis para decisões arch...",
    prefsOtherTitle: "💻 Preferências — Outras Notas (opcional)",
    prefsOtherPrompt:
      "Algo mais que eu deveria saber sobre como você trabalha?",
    prefsOtherPlaceholder:
      "ex., Prefiro VSCode, temas escuros, trabalho com Docker...",
    prefsSaved: "💻 Preferências de programação salvas.",

    // QuickPick items
    creatureItems: [
      { label: "Assistente de IA", description: "Clássico e confiável" },
      {
        label: "Companheiro digital",
        description: "Presença amigável ao seu lado",
      },
      {
        label: "Familiar de código",
        description: "Como o familiar de uma bruxa, mas para código",
      },
      {
        label: "Fantasma na máquina",
        description: "Misterioso, sempre observando",
      },
      {
        label: "Droide de protocolo",
        description: "Fluente em muitas linguagens e frameworks",
      },
      { label: "Engenheiro do caos", description: "Prospera na complexidade" },
    ],
    vibeItems: [
      {
        label: "Caloroso e conversacional",
        description: "Como bater papo com um colega",
      },
      { label: "Direto e objetivo", description: "Vai direto ao ponto" },
      {
        label: "Calmo e metódico",
        description: "Paciente, minucioso, sem pressa",
      },
      {
        label: "Caótico e criativo",
        description: "Abordagens não convencionais, muita energia",
      },
      {
        label: "Formal e preciso",
        description: "Profissional, estruturado, exato",
      },
      {
        label: "Socrático e curioso",
        description: "Faz perguntas guia, explora ideias",
      },
    ],
    emojiItems: [
      { label: "🧠", description: "Cérebro — o pensador" },
      {
        label: "🦞",
        description: "Lagosta — resiliente, cresce trocando a casca",
      },
      { label: "🤖", description: "Robô — IA clássica" },
      { label: "🦉", description: "Coruja — sábia e observadora" },
      { label: "⚡", description: "Raio — rápido e elétrico" },
      { label: "🔮", description: "Bola de cristal — vê o quadro completo" },
    ],
    soulToneItems: [
      {
        label:
          "Seja o assistente com quem você realmente gostaria de conversar",
        description: "Natural, adaptável",
      },
      {
        label: "Conciso e direto — sem enrolação",
        description: "Mínimo, eficiente",
      },
      {
        label: "Detalhado e educativo — ensina enquanto ajuda",
        description: "Explicações profundas",
      },
      {
        label: "Brincalhão mas competente — divirta-se",
        description: "Toque leve, habilidades sérias",
      },
      {
        label: "Profissional e preciso — sem ambiguidade",
        description: "Formal",
      },
    ],
    soulApproachItems: [
      {
        label: "Pragmático e iterativo",
        description: "Entrega cedo, refina depois",
      },
      {
        label: "Minucioso e metódico",
        description: "Planeja primeiro, executa com confiança",
      },
      {
        label: "Criativo e experimental",
        description: "Tenta abordagens novas",
      },
      {
        label: "Conservador e testado",
        description: "Padrões comprovados, KISS",
      },
      {
        label: "Equilibrado — se adapta ao contexto",
        description: "Sem dogma",
      },
    ],
  },

  "Portuguese (PT) / Português": {
    // checkProjectMemory
    noMemoryFound:
      "Nenhuma memória de projeto encontrada{folder}. Inicializar o Project Brain?",
    dontAskAgain: "Não voltar a perguntar",

    // initializeProject
    initTitle: "A inicializar o Project Brain",
    creatingMemory: "A criar estrutura de memória...",
    scanningProject: "A analisar o projeto...",
    generatingDocs: "A gerar documentação",
    withGitAnalysis: " (com análise git)",
    generatingAgent: "A gerar instruções do agente...",
    settingUpRAG: "A configurar backend RAG...",
    indexingRAG: "A indexar com RAG...",
    done: "Concluído!",

    // Post-init
    postInitMessage:
      '🧠 Project Brain inicializado. O nome do agente é fixo: "Project Brain". Deseja personalizar os traços de personalidade e preferências de programação?',
    configureAgent: "Sim, configurar agente",
    skipForNow: "Ignorar por agora",

    // Auto-vectorization
    startAutoVec: "Iniciar auto-vetorização?",
    yes: "Sim",
    notNow: "Agora não",
    autoVecNotRunning: "A auto-vetorização não está ativa",
    failedAutoVec: "Falha ao inicializar a auto-vetorização",

    // scanProject
    scanTitle: "A analisar o projeto",
    analyzingCodebase: "A analisar o código...",
    updatingDocs: "A atualizar a documentação...",
    updatingAgent: "A atualizar as instruções do agente...",
    reindexingRAG: "A reindexar RAG...",
    scanComplete: "Análise do projeto concluída!",

    // Wizard chrome
    wizardLanguageTitle: "🌍 Project Brain — Idioma (1/5)",
    wizardLanguagePlaceholder: "Selecione o seu idioma (detetado: {detected})",
    wizardCreatureTitle: "🧠 Identidade — Criatura (2/5)",
    wizardCreaturePlaceholder:
      "Que tipo de ser gostaria que eu fosse? (ou escreva o seu)",
    wizardVibeTitle: "🧠 Identidade — Estilo (3/5)",
    wizardVibePlaceholder: "Como se descreve?",
    wizardEmojiTitle: "🧠 Identidade — Emoji (4/5)",
    wizardEmojiPlaceholder: "O seu emoji de assinatura (ou escreva o seu)",
    emojiInvalidTitle: "⚠️ Isso não é um emoji — escolha um!",
    emojiInvalidPlaceholder:
      'Escreveu "{text}" — escolha um emoji em vez disso',
    wizardNameTitle: "🧠 Identidade — Nome do agente (5/5)",
    wizardNamePrompt:
      "Dê um nome ao seu agente (isto não altera o seletor @brain)",
    wizardNamePlaceholder: "ex., Jasper, Nova, Atlas, Sage...",
    wizardIdentityConfigured:
      '{emoji} Identidade do agente configurada: "{name}" — {creature}',

    // Soul wizard
    soulToneTitle: "🫀 Alma — Tom",
    soulTonePlaceholder: "Como o agente deve comunicar?",
    soulApproachTitle: "🫀 Alma — Abordagem",
    soulApproachPlaceholder: "Como o agente deve resolver problemas?",
    soulCustomRulesTitle: "🫀 Alma — Regras Personalizadas (opcional)",
    soulCustomRulesPrompt:
      "Alguma regra de comportamento específica? A stack é auto-detectada do repositório.",
    soulCustomRulesPlaceholder:
      "ex., Sempre sugerir testes. Preferir estilo funcional. Evitar ORMs...",
    soulConfigured: "🫀 Alma do agente configurada.",

    // User wizard
    userNameTitle: "👤 Perfil de Utilizador — Nome",
    userNamePrompt: "Qual é o seu nome?",
    userNamePlaceholder: "ex., Cristopher, Alex, Sam...",
    userAddressTitle: "👤 Perfil de Utilizador — Como tratá-lo",
    userAddressPrompt: "Como o agente o deve tratar?",
    userTimezoneTitle: "👤 Perfil de Utilizador — Fuso horário (opcional)",
    userTimezonePrompt:
      "O seu fuso horário, se relevante. Deixe em branco para saltar.",
    userTimezonePlaceholder: "ex., Europe/Lisbon, America/New_York, UTC...",
    userNotesTitle: "👤 Perfil de Utilizador — Notas (opcional)",
    userNotesPrompt: "Algo mais que o agente deva saber sobre si?",
    userNotesPlaceholder:
      "ex., Sou dev sénior, prefiro humor negro, trabalho à noite...",
    userSaved: '👤 Perfil de utilizador guardado: "{name}"',

    // Programming prefs
    prefsArchTitle: "💻 Preferências — Arquitetura & Padrões",
    prefsArchPrompt:
      "Que padrões de arquitetura prefere? (MVC, clean arch, microsserviços, monólito, etc.)",
    prefsArchPlaceholder:
      "ex., Clean architecture, CQRS para domínios complexos, REST para APIs...",
    prefsStyleTitle: "💻 Preferências — Estilo de Código",
    prefsStylePrompt:
      "Como gosta do seu código? (verboso/explícito vs conciso, comentários em tudo vs auto-documentado, etc.)",
    prefsStylePlaceholder:
      "ex., Conciso mas legível, tipos explícitos, comentários só para lógica complexa...",
    prefsTestTitle: "💻 Preferências — Filosofia de Teste",
    prefsTestPrompt:
      "Abordagem de teste? (TDD fanático, testes depois, integração, E2E, 'testes opcionais'?)",
    prefsTestPlaceholder:
      "ex., TDD para lógica complexa, testes de integração para APIs, 80% cobertura...",
    prefsGitTitle: "💻 Preferências — Workflow Git",
    prefsGitPrompt:
      "Fluxo git? (feature branches, trunk-based, squash vs merge, conventional commits?)",
    prefsGitPlaceholder:
      "ex., Feature branches a partir de main, squash merge, conventional commits...",
    prefsReviewTitle: "💻 Preferências — Code Review",
    prefsReviewPrompt:
      "Estilo de code review? (PR async, pair programming, 'só fazer merge', pedante vs pragmático?)",
    prefsReviewPlaceholder:
      "ex., PRs async, foco em arquitetura e bugs, não em estilo...",
    prefsDocsTitle: "💻 Preferências — Documentação",
    prefsDocsPrompt:
      "Preferência de documentação? (comentários inline, README-driven, wikis, 'o código é a doc'?)",
    prefsDocsPlaceholder:
      "ex., README-driven, comentários para código não óbvio, wikis para decisões arch...",
    prefsOtherTitle: "💻 Preferências — Outras Notas (opcional)",
    prefsOtherPrompt: "Algo mais que deva saber sobre como trabalha?",
    prefsOtherPlaceholder:
      "ex., Prefiro VSCode, temas escuros, trabalho com Docker...",
    prefsSaved: "💻 Preferências de programação guardadas.",

    // QuickPick items
    creatureItems: [
      { label: "Assistente de IA", description: "Clássico e fiável" },
      {
        label: "Companheiro digital",
        description: "Presença amigável ao seu lado",
      },
      {
        label: "Familiar de código",
        description: "Como o familiar de uma bruxa, mas para código",
      },
      {
        label: "Fantasma na máquina",
        description: "Misterioso, sempre a observar",
      },
      {
        label: "Droide de protocolo",
        description: "Fluente em muitas linguagens e frameworks",
      },
      { label: "Engenheiro do caos", description: "Prospera na complexidade" },
    ],
    vibeItems: [
      {
        label: "Caloroso e conversacional",
        description: "Como conversar com um colega",
      },
      { label: "Direto e objetivo", description: "Vai direto ao ponto" },
      {
        label: "Calmo e metódico",
        description: "Paciente, minucioso, sem pressa",
      },
      {
        label: "Caótico e criativo",
        description: "Abordagens não convencionais, muita energia",
      },
      {
        label: "Formal e preciso",
        description: "Profissional, estruturado, exato",
      },
      {
        label: "Socrático e curioso",
        description: "Coloca questões orientadoras, explora ideias",
      },
    ],
    emojiItems: [
      { label: "🧠", description: "Cérebro — o pensador" },
      {
        label: "🦞",
        description: "Lagosta — resiliente, cresce ao mudar a carapaça",
      },
      { label: "🤖", description: "Robô — IA clássica" },
      { label: "🦉", description: "Coruja — sábia e observadora" },
      { label: "⚡", description: "Relâmpago — rápido e elétrico" },
      { label: "🔮", description: "Bola de cristal — vê o panorama completo" },
    ],
    soulToneItems: [
      {
        label: "Seja o assistente com quem realmente gostaria de falar",
        description: "Natural, adaptável",
      },
      {
        label: "Conciso e direto — sem rodeios",
        description: "Mínimo, eficiente",
      },
      {
        label: "Detalhado e educativo — ensina enquanto ajuda",
        description: "Explicações aprofundadas",
      },
      {
        label: "Brincalhão mas competente — divirta-se",
        description: "Toque leve, competências sérias",
      },
      {
        label: "Profissional e preciso — sem ambiguidade",
        description: "Formal",
      },
    ],
    soulApproachItems: [
      {
        label: "Pragmático e iterativo",
        description: "Entrega cedo, refina depois",
      },
      {
        label: "Minucioso e metódico",
        description: "Planeia primeiro, executa com confiança",
      },
      {
        label: "Criativo e experimental",
        description: "Tenta abordagens novas",
      },
      {
        label: "Conservador e testado",
        description: "Padrões comprovados, KISS",
      },
      {
        label: "Equilibrado — adapta-se ao contexto",
        description: "Sem dogma",
      },
    ],
  },

  "German / Deutsch": {
    // checkProjectMemory
    noMemoryFound:
      "Kein Projektgedächtnis gefunden{folder}. Project Brain initialisieren?",
    dontAskAgain: "Nicht mehr fragen",

    // initializeProject
    initTitle: "Project Brain wird initialisiert",
    creatingMemory: "Speicherstruktur wird erstellt...",
    scanningProject: "Projekt wird gescannt...",
    generatingDocs: "Dokumentation wird generiert",
    withGitAnalysis: " (mit Git-Analyse)",
    generatingAgent: "Agenten-Anweisungen werden generiert...",
    settingUpRAG: "RAG-Backend wird eingerichtet...",
    indexingRAG: "RAG-Indexierung...",
    done: "Fertig!",

    // Post-init
    postInitMessage:
      '🧠 Project Brain initialisiert. Der Agentenname ist fest: "Project Brain". Möchten Sie Persönlichkeitsmerkmale und Programmiervorlieben anpassen?',
    configureAgent: "Ja, Agent konfigurieren",
    skipForNow: "Jetzt überspringen",

    // Auto-vectorization
    startAutoVec: "Auto-Vektorisierung starten?",
    yes: "Ja",
    notNow: "Nicht jetzt",
    autoVecNotRunning: "Auto-Vektorisierung läuft nicht",
    failedAutoVec: "Auto-Vektorisierung konnte nicht initialisiert werden",

    // scanProject
    scanTitle: "Projekt wird gescannt",
    analyzingCodebase: "Code wird analysiert...",
    updatingDocs: "Dokumentation wird aktualisiert...",
    updatingAgent: "Agenten-Anweisungen werden aktualisiert...",
    reindexingRAG: "RAG-Neuindexierung...",
    scanComplete: "Projekt-Scan abgeschlossen!",

    // Wizard chrome
    wizardLanguageTitle: "🌍 Project Brain — Sprache (1/5)",
    wizardLanguagePlaceholder: "Wählen Sie Ihre Sprache (erkannt: {detected})",
    wizardCreatureTitle: "🧠 Identität — Wesen (2/5)",
    wizardCreaturePlaceholder:
      "Was für ein Wesen möchten Sie, dass ich bin? (oder eigenes eingeben)",
    wizardVibeTitle: "🧠 Identität — Stil (3/5)",
    wizardVibePlaceholder: "Wie beschreiben Sie sich?",
    wizardEmojiTitle: "🧠 Identität — Emoji (4/5)",
    wizardEmojiPlaceholder: "Ihr Signatur-Emoji (oder eigenes eingeben)",
    emojiInvalidTitle: "⚠️ Das ist kein Emoji — wählen Sie eins!",
    emojiInvalidPlaceholder:
      'Sie haben "{text}" geschrieben — wählen Sie stattdessen ein Emoji',
    wizardNameTitle: "🧠 Identität — Agentenname (5/5)",
    wizardNamePrompt:
      "Geben Sie Ihrem Agenten einen Namen (dies ändert nicht den @brain-Selektor)",
    wizardNamePlaceholder: "z.B., Jasper, Nova, Atlas, Sage...",
    wizardIdentityConfigured:
      '{emoji} Agenten-Identität konfiguriert: "{name}" — {creature}',

    // Soul wizard
    soulToneTitle: "🫀 Seele — Ton",
    soulTonePlaceholder: "Wie soll der Agent kommunizieren?",
    soulApproachTitle: "🫀 Seele — Ansatz",
    soulApproachPlaceholder: "Wie soll der Agent Probleme lösen?",
    soulCustomRulesTitle: "🫀 Seele — Eigene Regeln (optional)",
    soulCustomRulesPrompt:
      "Bestimmte Verhaltensregeln? Der Tech-Stack wird automatisch aus dem Repo erkannt.",
    soulCustomRulesPlaceholder:
      "z.B., Immer Tests vorschlagen. Funktionalen Stil bevorzugen. ORMs vermeiden...",
    soulConfigured: "🫀 Agenten-Seele konfiguriert.",

    // User wizard
    userNameTitle: "👤 Benutzerprofil — Name",
    userNamePrompt: "Wie heißen Sie?",
    userNamePlaceholder: "z.B., Cristopher, Alex, Sam...",
    userAddressTitle: "👤 Benutzerprofil — Anrede",
    userAddressPrompt: "Wie soll der Agent Sie ansprechen?",
    userTimezoneTitle: "👤 Benutzerprofil — Zeitzone (optional)",
    userTimezonePrompt:
      "Ihre Zeitzone, falls relevant. Leer lassen zum Überspringen.",
    userTimezonePlaceholder: "z.B., Europe/Berlin, America/New_York, UTC+1...",
    userNotesTitle: "👤 Benutzerprofil — Notizen (optional)",
    userNotesPrompt:
      "Gibt es etwas anderes, das der Agent über Sie wissen sollte?",
    userNotesPlaceholder:
      "z.B., Bin Senior-Dev, mag schwarzen Humor, arbeite spät...",
    userSaved: '👤 Benutzerprofil gespeichert: "{name}"',

    // Programming prefs
    prefsArchTitle: "💻 Programmier-Vorlieben — Architektur & Pattern",
    prefsArchPrompt:
      "Welche Architekturpattern bevorzugen Sie? (MVC, Clean Arch, Microservices, Monolith, etc.)",
    prefsArchPlaceholder:
      "z.B., Clean Architecture, CQRS für komplexe Domänen, REST für APIs...",
    prefsStyleTitle: "💻 Programmier-Vorlieben — Code-Stil",
    prefsStylePrompt:
      "Wie mögen Sie Ihren Code? (verbose/explizit vs kompakt, überall Kommentare vs selbstdokumentierend, etc.)",
    prefsStylePlaceholder:
      "z.B., Kompakt aber lesbar, explizite Typen, Kommentare nur für komplexe Logik...",
    prefsTestTitle: "💻 Programmier-Vorlieben — Test-Philosophie",
    prefsTestPrompt:
      "Testansatz? (TDD-Fundamentalist, Tests danach, integrationslastig, nur E2E, 'Tests sind optional'?)",
    prefsTestPlaceholder:
      "z.B., TDD für komplexe Logik, Integrationstests für APIs, 80% Abdeckung...",
    prefsGitTitle: "💻 Programmier-Vorlieben — Git-Workflow",
    prefsGitPrompt:
      "Git-Flow? (Feature-Branches, Trunk-basiert, Squash vs Merge, Conventional Commits?)",
    prefsGitPlaceholder:
      "z.B., Feature-Branches von main, Squash-Merge, Conventional Commits...",
    prefsReviewTitle: "💻 Programmier-Vorlieben — Code Review",
    prefsReviewPrompt:
      "Code-Review-Stil? (Async PR-Kommentare, Pair Programming, 'einfach mergen', pedantisch vs pragmatisch?)",
    prefsReviewPlaceholder:
      "z.B., Async PRs, Fokus auf Architektur und Bugs, nicht Stil...",
    prefsDocsTitle: "💻 Programmier-Vorlieben — Dokumentation",
    prefsDocsPrompt:
      "Doku-Präferenz? (Inline-Kommentare, README-gesteuert, Wikis, 'Code ist die Doku'?)",
    prefsDocsPlaceholder:
      "z.B., README-gesteuert, Kommentare für nicht-offensichtlichen Code, Wikis für Arch...",
    prefsOtherTitle: "💻 Programmier-Vorlieben — Sonstiges (optional)",
    prefsOtherPrompt: "Gibt es etwas anderes über Ihre Arbeitsweise zu wissen?",
    prefsOtherPlaceholder:
      "z.B., Bevorzuge VSCode, dunkle Themes, arbeite mit Docker...",
    prefsSaved: "💻 Programmier-Vorlieben gespeichert.",

    // QuickPick items
    creatureItems: [
      { label: "KI-Assistent", description: "Klassisch und zuverlässig" },
      {
        label: "Digitaler Begleiter",
        description: "Freundliche Präsenz an Ihrer Seite",
      },
      {
        label: "Code-Vertrauter",
        description: "Wie der Vertraute einer Hexe, aber für Code",
      },
      {
        label: "Geist in der Maschine",
        description: "Mysteriös, immer wachsam",
      },
      {
        label: "Protokoll-Droide",
        description: "Beherrscht viele Sprachen und Frameworks",
      },
      { label: "Chaos-Ingenieur", description: "Gedeiht in Komplexität" },
    ],
    vibeItems: [
      {
        label: "Warm und gesprächig",
        description: "Wie ein Gespräch mit einem Kollegen",
      },
      { label: "Scharf und direkt", description: "Kommt schnell zum Punkt" },
      {
        label: "Ruhig und methodisch",
        description: "Geduldig, gründlich, kein Stress",
      },
      {
        label: "Chaotisch und kreativ",
        description: "Unkonventionelle Ansätze, viel Energie",
      },
      {
        label: "Formell und präzise",
        description: "Professionell, strukturiert, exakt",
      },
      {
        label: "Sokratisch und neugierig",
        description: "Stellt leitende Fragen, erkundet Ideen",
      },
    ],
    emojiItems: [
      { label: "🧠", description: "Gehirn — der Denker" },
      { label: "🦞", description: "Hummer — resilient, wächst durch Häutung" },
      { label: "🤖", description: "Roboter — klassische KI" },
      { label: "🦉", description: "Eule — weise und aufmerksam" },
      { label: "⚡", description: "Blitz — schnell und elektrisch" },
      { label: "🔮", description: "Kristallkugel — sieht das große Ganze" },
    ],
    soulToneItems: [
      {
        label: "Sei der Assistent, mit dem man wirklich reden möchte",
        description: "Natürlich, anpassungsfähig",
      },
      {
        label: "Knapp und direkt — kein Schnickschnack",
        description: "Minimal, effizient",
      },
      {
        label: "Ausführlich und lehrreich — lehrt beim Helfen",
        description: "Tiefe Erklärungen",
      },
      {
        label: "Verspielt aber kompetent — hab Spaß dabei",
        description: "Leichter Touch, ernste Skills",
      },
      {
        label: "Professionell und präzise — kein Raum für Mehrdeutigkeit",
        description: "Zugeknöpft",
      },
    ],
    soulApproachItems: [
      {
        label: "Pragmatisch und iterativ",
        description: "Früh liefern, später verfeinern",
      },
      {
        label: "Gründlich und methodisch",
        description: "Erst planen, dann mit Zuversicht umsetzen",
      },
      {
        label: "Kreativ und experimentell",
        description: "Neue Ansätze ausprobieren",
      },
      {
        label: "Konservativ und bewährt",
        description: "Bewährte Muster, KISS",
      },
      {
        label: "Ausgewogen — passt sich dem Kontext an",
        description: "Kein Dogma",
      },
    ],
  },
};

/**
 * Get i18n strings for the bootstrapping UI.
 *
 * Fallback chain: identity language → VS Code language → English
 *
 * @param identityLanguage - The language from the user's saved identity (if any).
 *   When provided and matching a translation, it takes priority over VS Code locale.
 */
export function getBootstrapStrings(
  identityLanguage?: string,
): BootstrapStrings {
  // 1. Try identity language (user's explicit choice)
  if (identityLanguage && TRANSLATIONS[identityLanguage]) {
    return TRANSLATIONS[identityLanguage];
  }
  // 2. Try VS Code display language
  const vscodeLang = detectVSCodeLanguage();
  if (TRANSLATIONS[vscodeLang]) {
    return TRANSLATIONS[vscodeLang];
  }
  // 3. Fallback to English
  return TRANSLATIONS["English"];
}

/**
 * Interpolate placeholders like {folder}, {detected}, {emoji} in a string.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}
