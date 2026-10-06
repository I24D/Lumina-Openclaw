/**
 * affordances.ts — What a thing lets you do with it, roughly.
 *
 * M3GAN spec §122: cup → can contain, chair → can sit, door → can open,
 * switch → can toggle. An affordance says an action is possible, never that it
 * should happen: the safety supervisor still reviews every intent, and a
 * physically possible action needs the same autonomy and consent as any other
 * ("No ejecutar una acción únicamente porque sea físicamente posible").
 *
 * Sources, strongest first: what a person or a sensor recorded on the entity
 * (an `affordances` property, comma separated, and `graspable` true/false),
 * then the category its label names (English and Spanish), then its kind. A
 * thing none of these covers has unknown affordances: a knowledge gap the
 * curiosity rule may ask about, never a reason to experiment on it.
 */
import type { WorldEntity } from "./world-model.js";

export const AFFORDANCES = [
  "grasp",
  "contain",
  "pour",
  "sit",
  "open",
  "close",
  "toggle",
  "support",
  "charge",
  "read",
  "write",
  "cut",
  "wear",
  "play",
  "eat",
] as const;
export type Affordance = (typeof AFFORDANCES)[number];

export type AffordanceAssessment = {
  readonly affords: ReadonlyArray<Affordance>;
  readonly source: "recorded" | "category" | "kind" | "unknown";
  /** The category the label matched, when it matched one. */
  readonly category?: string;
  /** Sharp or pointed: handled slowly and handed over with care. */
  readonly sharp: boolean;
};

type Category = {
  readonly name: string;
  readonly words: ReadonlyArray<string>;
  readonly affords: ReadonlyArray<Affordance>;
  readonly sharp?: boolean;
};

const CATEGORIES: ReadonlyArray<Category> = [
  {
    name: "drinking vessel",
    words: ["cup", "mug", "glass", "taza", "vaso", "copa", "pocillo"],
    affords: ["grasp", "contain", "pour"],
  },
  {
    name: "bottle",
    words: ["bottle", "jar", "flask", "thermos", "botella", "frasco", "termo", "jarra"],
    affords: ["grasp", "contain", "pour", "open", "close"],
  },
  {
    name: "dish",
    words: ["bowl", "plate", "tray", "plato", "tazon", "bandeja"],
    affords: ["grasp", "contain"],
  },
  {
    name: "seat",
    words: [
      "chair",
      "stool",
      "sofa",
      "couch",
      "bench",
      "armchair",
      "silla",
      "taburete",
      "banco",
      "sillon",
    ],
    affords: ["sit", "support"],
  },
  {
    name: "table",
    words: [
      "table",
      "desk",
      "shelf",
      "counter",
      "nightstand",
      "mesa",
      "escritorio",
      "estante",
      "repisa",
      "buro",
    ],
    affords: ["support"],
  },
  { name: "bed", words: ["bed", "cama"], affords: ["sit", "support"] },
  { name: "door", words: ["door", "gate", "puerta", "porton"], affords: ["open", "close"] },
  { name: "window", words: ["window", "ventana"], affords: ["open", "close"] },
  {
    name: "storage",
    words: [
      "drawer",
      "cabinet",
      "cupboard",
      "closet",
      "fridge",
      "refrigerator",
      "cajon",
      "gabinete",
      "alacena",
      "armario",
      "refrigerador",
      "nevera",
    ],
    affords: ["open", "close", "contain"],
  },
  {
    name: "bag or box",
    words: [
      "box",
      "bag",
      "basket",
      "backpack",
      "handbag",
      "suitcase",
      "caja",
      "bolsa",
      "bolso",
      "maleta",
      "canasta",
      "mochila",
      "cesta",
    ],
    affords: ["grasp", "contain", "open", "close"],
  },
  {
    name: "switch",
    words: ["switch", "button", "lamp", "light", "interruptor", "boton", "lampara", "luz", "foco"],
    affords: ["toggle"],
  },
  {
    name: "handheld device",
    words: [
      "phone",
      "smartphone",
      "tablet",
      "remote",
      "controller",
      "telefono",
      "celular",
      "movil",
      "control",
      "mando",
    ],
    affords: ["grasp", "toggle", "charge"],
  },
  {
    name: "computer",
    words: ["laptop", "portatil", "notebook computer"],
    affords: ["grasp", "open", "close", "toggle", "charge"],
  },
  { name: "charger", words: ["charger", "dock", "cargador"], affords: ["charge"] },
  {
    name: "reading matter",
    words: ["book", "notebook", "magazine", "libro", "cuaderno", "revista", "libreta"],
    affords: ["grasp", "read", "open", "close"],
  },
  {
    name: "writing tool",
    words: ["pen", "pencil", "marker", "boligrafo", "lapiz", "pluma", "plumon"],
    affords: ["grasp", "write"],
  },
  {
    name: "blade",
    words: ["knife", "scissors", "blade", "cutter", "cuchillo", "tijeras", "navaja", "cuter"],
    affords: ["grasp", "cut"],
    sharp: true,
  },
  {
    name: "clothing",
    words: [
      "shirt",
      "jacket",
      "hat",
      "cap",
      "sweater",
      "shoe",
      "camisa",
      "chaqueta",
      "sombrero",
      "gorra",
      "sueter",
      "zapato",
      "tie",
      "corbata",
    ],
    affords: ["grasp", "wear"],
  },
  {
    name: "toy",
    words: [
      "toy",
      "ball",
      "doll",
      "teddy",
      "frisbee",
      "kite",
      "juguete",
      "pelota",
      "balon",
      "muneca",
      "peluche",
    ],
    affords: ["grasp", "play"],
  },
  {
    name: "screen",
    words: ["tv", "television", "monitor", "televisor", "tele", "pantalla"],
    affords: ["toggle"],
  },
  {
    name: "kitchen appliance",
    words: [
      "microwave",
      "oven",
      "toaster",
      "kettle",
      "microondas",
      "horno",
      "tostadora",
      "hervidor",
    ],
    affords: ["open", "close", "toggle"],
  },
  { name: "sink", words: ["sink", "fregadero", "lavabo", "lavamanos"], affords: ["contain"] },
  { name: "toilet", words: ["toilet", "inodoro", "retrete"], affords: ["sit"] },
  { name: "clock", words: ["clock", "reloj"], affords: ["read"] },
  {
    name: "vase or plant",
    words: ["vase", "plant", "florero", "jarron", "planta", "maceta"],
    affords: ["grasp", "contain"],
  },
  {
    name: "cutlery",
    words: ["spoon", "fork", "cuchara", "tenedor"],
    affords: ["grasp"],
  },
  {
    name: "food",
    words: [
      "banana",
      "apple",
      "orange",
      "sandwich",
      "pizza",
      "donut",
      "cake",
      "broccoli",
      "carrot",
      "hot dog",
      "platano",
      "manzana",
      "naranja",
      "pastel",
      "zanahoria",
      "galleta",
    ],
    affords: ["grasp", "eat"],
  },
  {
    name: "computer peripheral",
    words: ["mouse", "keyboard", "raton", "teclado"],
    affords: ["grasp"],
  },
  {
    name: "umbrella",
    words: ["umbrella", "paraguas", "sombrilla"],
    affords: ["grasp", "open", "close"],
  },
  {
    name: "personal care",
    words: ["toothbrush", "hair drier", "hair dryer", "cepillo", "secador"],
    affords: ["grasp"],
  },
  {
    name: "small belonging",
    words: [
      "key",
      "keys",
      "wallet",
      "glasses",
      "llave",
      "llaves",
      "cartera",
      "billetera",
      "lentes",
      "gafas",
    ],
    affords: ["grasp"],
  },
];

/** What a kind alone says when the label names no category. */
const BY_KIND: Readonly<Partial<Record<WorldEntity["kind"], ReadonlyArray<Affordance>>>> = {
  furniture: ["support"],
  door: ["open", "close"],
  container: ["contain"],
  surface: ["support"],
  tool: ["grasp"],
  // People, animals, rooms and places afford nothing to pick up or operate.
  person: [],
  animal: [],
  room: [],
  location: [],
};

/** Lower case, accents off, so "Lámpara" and "lampara" match. */
const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function categoryOf(label: string): Category | undefined {
  const words = normalize(label)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const text = ` ${words.join(" ")} `;
  const matches = (candidates: ReadonlyArray<string>) =>
    CATEGORIES.find((category) =>
      category.words.some((word) =>
        word.includes(" ") ? text.includes(` ${word} `) : candidates.includes(word),
      ),
    );
  // Exact words first, so "glasses" is eyewear before its singular is a glass.
  const singulars = words.flatMap((w) =>
    w.endsWith("es") ? [w.slice(0, -1), w.slice(0, -2)] : w.endsWith("s") ? [w.slice(0, -1)] : [],
  );
  return matches(words) ?? matches(singulars);
}

const isAffordance = (value: string): value is Affordance =>
  (AFFORDANCES as ReadonlyArray<string>).includes(value);

export function affordancesOf(
  entity: Pick<WorldEntity, "kind" | "label" | "properties">,
): AffordanceAssessment {
  // Entity identity outranks labels and editable properties. These are not objects
  // to manipulate, even if somebody names a person "Cup" or records graspable=true.
  if (
    entity.kind === "person" ||
    entity.kind === "animal" ||
    entity.kind === "room" ||
    entity.kind === "location"
  ) {
    return { affords: [], source: "kind", sharp: false };
  }
  const category = categoryOf(entity.label);
  const sharp = entity.properties.sharp === true || category?.sharp === true;
  const recorded = entity.properties.affordances;
  const graspable = entity.properties.graspable;
  const adjust = (base: ReadonlyArray<Affordance>): Affordance[] => {
    const out = new Set(base);
    if (graspable === true) {
      out.add("grasp");
    } else if (graspable === false) {
      out.delete("grasp");
    }
    return [...out];
  };
  if (typeof recorded === "string" && recorded.trim()) {
    const recordedAffordances = recorded
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(isAffordance);
    return { affords: adjust(recordedAffordances), source: "recorded", sharp };
  }
  if (category) {
    return {
      affords: adjust(category.affords),
      source: "category",
      category: category.name,
      sharp,
    };
  }
  const byKind = BY_KIND[entity.kind];
  if (byKind) {
    return { affords: adjust(byKind), source: "kind", sharp };
  }
  if (typeof graspable === "boolean") {
    return { affords: adjust([]), source: "recorded", sharp };
  }
  return { affords: [], source: "unknown", sharp };
}

/** True or false when known; undefined when nothing says (ask, do not experiment). */
export function affords(
  entity: Pick<WorldEntity, "kind" | "label" | "properties">,
  affordance: Affordance,
): boolean | undefined {
  const assessment = affordancesOf(entity);
  return assessment.source === "unknown" ? undefined : assessment.affords.includes(affordance);
}
