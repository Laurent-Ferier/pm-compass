/**
 * The emoji a project's icon can be chosen from, in the groups the picker draws them under,
 * each with the words it answers to. Not every emoji there is: one that names no project
 * earns no cell, and the words are what make a big grid findable rather than scanned.
 *
 * A glyph appears once. Its words are what somebody would type looking for it — the thing
 * it depicts and what it tends to stand for — and are matched as fragments, so `plan` finds
 * `planning`.
 */

export interface EmojiEntry {
  glyph: string;
  /** Lowercase, single words. The group's name is searched too, so it isn't repeated here. */
  words: string[];
}

export interface EmojiGroup {
  name: string;
  entries: EmojiEntry[];
}

/** `glyph words…` — the table below is read far more often than it is edited. */
function entry(glyph: string, ...words: string[]): EmojiEntry {
  return { glyph, words };
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: "Work and planning",
    entries: [
      entry("📋", "clipboard", "task", "list", "project"),
      entry("📝", "memo", "note", "write", "todo"),
      entry("🗒️", "notepad", "notes", "jotting"),
      entry("📌", "pin", "pinned", "important"),
      entry("📎", "paperclip", "attach"),
      entry("🗂️", "dividers", "files", "organise", "sort"),
      entry("📁", "folder", "directory"),
      entry("📂", "folder", "open", "directory"),
      entry("🗃️", "box", "files", "index"),
      entry("🗄️", "cabinet", "filing", "archive"),
      entry("✅", "check", "done", "complete", "tick"),
      entry("☑️", "checkbox", "done", "tick"),
      entry("🔖", "bookmark", "label", "mark"),
      entry("🏷️", "label", "tag", "price"),
      entry("📇", "index", "cards", "contacts"),
      entry("🗓️", "calendar", "schedule", "planning"),
      entry("📅", "calendar", "date", "planning"),
      entry("⏱️", "stopwatch", "timer", "time"),
      entry("⏳", "hourglass", "waiting", "deadline"),
      entry("⏰", "alarm", "clock", "reminder"),
    ],
  },
  {
    name: "Goals and ideas",
    entries: [
      entry("🎯", "target", "goal", "aim", "focus"),
      entry("🚀", "rocket", "launch", "ship", "fast"),
      entry("💡", "idea", "lightbulb", "insight"),
      entry("✨", "sparkles", "new", "magic", "polish"),
      entry("🔥", "fire", "hot", "urgent"),
      entry("⭐", "star", "favourite", "important"),
      entry("🌟", "star", "glowing", "highlight"),
      entry("🏆", "trophy", "win", "award"),
      entry("🥇", "medal", "first", "gold", "win"),
      entry("🎖️", "medal", "honour", "award"),
      entry("🧭", "compass", "direction", "navigate"),
      entry("🗺️", "map", "route", "plan"),
      entry("🚩", "flag", "milestone", "mark"),
      entry("🏁", "finish", "flag", "race", "end"),
      entry("📈", "chart", "growth", "up", "trend"),
      entry("📉", "chart", "decline", "down", "trend"),
      entry("📊", "chart", "bar", "stats", "data"),
      entry("🔮", "crystal", "forecast", "future"),
    ],
  },
  {
    name: "Tools and building",
    entries: [
      entry("🔧", "wrench", "spanner", "fix", "tool"),
      entry("🔨", "hammer", "build", "tool"),
      entry("🛠️", "tools", "maintenance", "build"),
      entry("⚙️", "gear", "cog", "settings", "config"),
      entry("🧰", "toolbox", "kit", "tools"),
      entry("🪛", "screwdriver", "fix", "tool"),
      entry("🔩", "bolt", "nut", "hardware"),
      entry("🧱", "brick", "wall", "build"),
      entry("🏗️", "construction", "crane", "build"),
      entry("🪚", "saw", "cut", "wood"),
      entry("🧲", "magnet", "attract"),
      entry("🪜", "ladder", "climb", "reach"),
      entry("🧹", "broom", "clean", "tidy", "sweep"),
      entry("🧽", "sponge", "clean", "wash"),
      entry("🗑️", "bin", "trash", "delete", "rubbish"),
    ],
  },
  {
    name: "Tech",
    entries: [
      entry("💻", "laptop", "computer", "code"),
      entry("🖥️", "desktop", "computer", "screen"),
      entry("🖱️", "mouse", "pointer", "input"),
      entry("⌨️", "keyboard", "typing", "input"),
      entry("🖨️", "printer", "print"),
      entry("📱", "phone", "mobile", "app"),
      entry("⌚", "watch", "wearable", "time"),
      entry("💾", "floppy", "save", "disk"),
      entry("💿", "disc", "media", "cd"),
      entry("🔌", "plug", "power", "connect"),
      entry("🔋", "battery", "power", "charge"),
      entry("📡", "satellite", "dish", "signal", "network"),
      entry("🛰️", "satellite", "space", "orbit"),
      entry("🌐", "globe", "web", "internet", "network"),
      entry("🔗", "link", "url", "chain"),
      entry("🤖", "robot", "bot", "automation"),
      entry("🐛", "bug", "defect", "issue"),
    ],
  },
  {
    name: "Science and health",
    entries: [
      entry("🧪", "tube", "experiment", "lab", "test"),
      entry("🔬", "microscope", "research", "lab"),
      entry("🧬", "dna", "genetics", "biology"),
      entry("⚗️", "alembic", "chemistry", "lab"),
      entry("🧫", "petri", "culture", "lab"),
      entry("🩺", "stethoscope", "doctor", "checkup"),
      entry("💊", "pill", "medicine", "treatment"),
      entry("🩹", "bandage", "patch", "fix"),
      entry("🧠", "brain", "think", "mind"),
      entry("🫀", "heart", "organ", "cardio"),
      entry("🦷", "tooth", "dental", "teeth"),
      entry("🌡️", "thermometer", "temperature", "fever"),
      entry("♻️", "recycle", "reuse", "green"),
    ],
  },
  {
    name: "Money and business",
    entries: [
      entry("💰", "money", "bag", "budget", "funds"),
      entry("💵", "cash", "note", "dollar"),
      entry("💳", "card", "payment", "credit"),
      entry("🧾", "receipt", "invoice", "bill"),
      entry("🏦", "bank", "finance"),
      entry("💼", "briefcase", "work", "job"),
      entry("📦", "package", "box", "shipping", "delivery"),
      entry("🛒", "cart", "shopping", "buy"),
      entry("🛍️", "bags", "shopping", "retail"),
      entry("🏪", "shop", "store", "convenience"),
      entry("🏬", "store", "department", "retail"),
      entry("⚖️", "scales", "legal", "balance", "law"),
      entry("🤝", "handshake", "deal", "partner", "agreement"),
      entry("📮", "postbox", "mail", "send"),
    ],
  },
  {
    name: "Places and home",
    entries: [
      entry("🏠", "house", "home"),
      entry("🏡", "house", "garden", "home"),
      entry("🏢", "office", "building", "company"),
      entry("🏭", "factory", "industry", "plant"),
      entry("🏫", "school", "education"),
      entry("🏥", "hospital", "clinic"),
      entry("🏛️", "museum", "institution", "government"),
      entry("⛪", "church", "chapel"),
      entry("🏰", "castle", "fortress"),
      entry("🗼", "tower", "landmark"),
      entry("🌆", "city", "skyline", "urban"),
      entry("🏝️", "island", "beach", "holiday"),
      entry("⛺", "tent", "camping", "outdoors"),
      entry("🏞️", "park", "landscape", "nature"),
    ],
  },
  {
    name: "Travel",
    entries: [
      entry("✈️", "plane", "flight", "aeroplane"),
      entry("🚗", "car", "drive"),
      entry("🚕", "taxi", "cab"),
      entry("🚌", "bus", "coach"),
      entry("🚆", "train", "rail"),
      entry("🚲", "bicycle", "bike", "cycling"),
      entry("🛵", "scooter", "moped"),
      entry("🚢", "ship", "boat", "sea"),
      entry("⛵", "sailboat", "sailing", "yacht"),
      entry("🚁", "helicopter", "flight"),
      entry("🧳", "luggage", "suitcase", "packing"),
      entry("🗽", "statue", "landmark", "liberty"),
      entry("🛣️", "road", "motorway", "route"),
      entry("⛽", "fuel", "petrol", "station"),
    ],
  },
  {
    name: "Nature and weather",
    entries: [
      entry("🌍", "earth", "world", "global"),
      entry("🌱", "seedling", "growth", "start", "sprout"),
      entry("🌳", "tree", "forest"),
      entry("🌲", "tree", "pine", "forest"),
      entry("🌵", "cactus", "desert", "plant"),
      entry("🌻", "sunflower", "flower", "summer"),
      entry("🌸", "blossom", "flower", "spring"),
      entry("🍀", "clover", "luck"),
      entry("🍁", "leaf", "maple", "autumn"),
      entry("☀️", "sun", "sunny", "clear"),
      entry("🌤️", "sun", "cloud", "fair"),
      entry("🌧️", "rain", "wet", "shower"),
      entry("⛈️", "storm", "thunder", "lightning"),
      entry("❄️", "snow", "cold", "winter", "frost"),
      entry("🌊", "wave", "sea", "water", "ocean"),
      entry("🌈", "rainbow", "colour", "pride"),
      entry("🌙", "moon", "night", "evening"),
      entry("🐝", "bee", "insect", "honey"),
      entry("🐕", "dog", "pet", "animal"),
      entry("🐈", "cat", "pet", "animal"),
    ],
  },
  {
    name: "Food and drink",
    entries: [
      entry("🍳", "cooking", "egg", "breakfast", "pan"),
      entry("🍎", "apple", "fruit"),
      entry("🍞", "bread", "bakery", "loaf"),
      entry("🧀", "cheese", "dairy"),
      entry("🥗", "salad", "healthy", "greens"),
      entry("🍕", "pizza", "takeaway"),
      entry("🍔", "burger", "takeaway"),
      entry("🍜", "noodles", "ramen", "soup"),
      entry("🍰", "cake", "dessert", "birthday"),
      entry("🍫", "chocolate", "sweet"),
      entry("🥕", "carrot", "vegetable", "veg"),
      entry("☕", "coffee", "break", "drink"),
      entry("🍵", "tea", "drink", "brew"),
      entry("🍺", "beer", "pub", "drink"),
      entry("🍷", "wine", "drink"),
      entry("🥂", "celebrate", "toast", "cheers"),
    ],
  },
  {
    name: "Sport and leisure",
    entries: [
      entry("🏃", "running", "run", "jog", "exercise"),
      entry("🚴", "cycling", "bike", "exercise"),
      entry("🏋️", "weights", "gym", "strength", "lifting"),
      entry("🧘", "yoga", "meditation", "calm", "stretch"),
      entry("⚽", "football", "soccer", "sport"),
      entry("🏀", "basketball", "sport"),
      entry("🎾", "tennis", "sport"),
      entry("🏊", "swimming", "swim", "pool"),
      entry("⛷️", "ski", "snow", "slope"),
      entry("🥾", "hiking", "boots", "walking"),
      entry("🎣", "fishing", "angling", "fish"),
      entry("🎲", "dice", "game", "chance"),
      entry("🎮", "game", "gaming", "console"),
      entry("🧩", "puzzle", "jigsaw", "problem"),
      entry("♟️", "chess", "strategy", "game"),
    ],
  },
  {
    name: "Arts and media",
    entries: [
      entry("🎨", "art", "paint", "palette", "design"),
      entry("🖌️", "paintbrush", "art", "design"),
      entry("✏️", "pencil", "draw", "sketch"),
      entry("🖊️", "pen", "write", "sign"),
      entry("🎬", "film", "movie", "clapper", "shoot"),
      entry("📷", "camera", "photo", "picture"),
      entry("📹", "video", "record", "camcorder"),
      entry("🎥", "movie", "camera", "film"),
      entry("🎵", "music", "note", "song"),
      entry("🎶", "music", "notes", "song"),
      entry("🎸", "guitar", "band", "music"),
      entry("🎹", "piano", "keyboard", "music"),
      entry("🥁", "drums", "percussion", "music"),
      entry("🎤", "microphone", "sing", "podcast"),
      entry("🎧", "headphones", "listen", "audio"),
      entry("🎭", "theatre", "drama", "acting"),
      entry("🪄", "wand", "magic", "effect"),
    ],
  },
  {
    name: "Learning and writing",
    entries: [
      entry("📚", "books", "library", "reading", "study"),
      entry("📖", "book", "reading", "open"),
      entry("📓", "notebook", "journal", "diary"),
      entry("📰", "news", "article", "paper"),
      entry("🗞️", "newspaper", "news", "press"),
      entry("🎓", "graduation", "education", "degree"),
      entry("✍️", "writing", "author", "hand"),
      entry("🔍", "search", "find", "magnify", "look"),
      entry("🔎", "search", "magnify", "find", "inspect"),
      entry("📜", "scroll", "document", "history"),
      entry("📄", "document", "page", "file"),
      entry("📑", "tabs", "sections", "document"),
      entry("🖇️", "paperclips", "attach", "bundle"),
    ],
  },
  {
    name: "People and talk",
    entries: [
      entry("💬", "speech", "comment", "chat", "message"),
      entry("🗨️", "speech", "quote", "chat"),
      entry("🗯️", "shout", "angry", "outburst"),
      entry("📣", "megaphone", "announce", "marketing"),
      entry("📢", "loudspeaker", "announce", "broadcast"),
      entry("🔔", "bell", "notify", "reminder", "alert"),
      entry("🔕", "bell", "muted", "silent", "quiet"),
      entry("✉️", "envelope", "mail", "letter"),
      entry("📧", "email", "mail", "message"),
      entry("📨", "mail", "incoming", "message"),
      entry("🗣️", "speaking", "talk", "voice"),
      entry("👥", "people", "team", "group"),
      entry("👤", "person", "user", "profile"),
      entry("🫂", "hug", "support", "together"),
      entry("❤️", "heart", "love", "favourite"),
      entry("👍", "thumb", "approve", "like", "ok"),
      entry("🙏", "thanks", "please", "pray"),
    ],
  },
  {
    name: "Marks and states",
    entries: [
      entry("🔒", "lock", "secure", "private", "closed"),
      entry("🔓", "unlock", "open", "access"),
      entry("🔑", "key", "access", "password"),
      entry("🛡️", "shield", "security", "protect", "defence"),
      entry("⚠️", "warning", "caution", "alert"),
      entry("🚧", "roadworks", "wip", "barrier", "progress"),
      entry("❗", "exclamation", "important", "urgent"),
      entry("❓", "question", "help", "unknown"),
      entry("♾️", "infinity", "endless", "ongoing"),
      entry("🔄", "refresh", "sync", "repeat"),
      entry("🔁", "repeat", "loop", "cycle", "recurring"),
      entry("⏸️", "pause", "hold", "break"),
      entry("▶️", "play", "start", "run"),
      entry("⏹️", "stop", "halt", "end"),
      entry("🆕", "new", "badge"),
      entry("🔝", "top", "up", "priority"),
      entry("💤", "sleep", "idle", "dormant"),
    ],
  },
];

/**
 * The groups whose entries answer to `query`, each cut to the entries that do — a group
 * matched by its own name keeps all of them, so `travel` shows the travel drawer whole.
 * An empty query is every group as written.
 */
export function matchingEmojiGroups(query: string): EmojiGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return EMOJI_GROUPS;
  return EMOJI_GROUPS.flatMap((group) => {
    if (group.name.toLowerCase().includes(needle)) return [group];
    const entries = group.entries.filter((e) => e.words.some((w) => w.includes(needle)));
    return entries.length ? [{ name: group.name, entries }] : [];
  });
}
