/**
 * DOM mutation summarization (docs/02: DOM_CHANGE carries counts + selectors,
 * never values or text). The content script maps real MutationRecords to
 * `MutationLike` and feeds them here; the debounced summary becomes one event.
 */

export interface MutationLike {
  type: "childList" | "attributes" | "characterData";
  addedNodes: number;
  removedNodes: number;
  attributeName?: string | null;
  /** Structural selector of the mutated node (already built by capture.ts). */
  targetSelector?: string;
}

export interface DomSummary {
  mutations: number;
  added: number;
  removed: number;
  attributes: number;
  characterData: number;
  attributeNames: string[];
  topTargets: string[];
}

const MAX_ATTR_NAMES = 10;
const MAX_TOP_TARGETS = 5;

export class DomSummaryAccumulator {
  #mutations = 0;
  #added = 0;
  #removed = 0;
  #attributes = 0;
  #characterData = 0;
  #attrNames = new Set<string>();
  #targets = new Map<string, number>();

  add(records: readonly MutationLike[]): void {
    for (const r of records) {
      this.#mutations += 1;
      this.#added += r.addedNodes;
      this.#removed += r.removedNodes;
      if (r.type === "attributes") {
        this.#attributes += 1;
        if (r.attributeName && this.#attrNames.size < MAX_ATTR_NAMES) this.#attrNames.add(r.attributeName);
      } else if (r.type === "characterData") {
        this.#characterData += 1;
      }
      if (r.targetSelector) this.#targets.set(r.targetSelector, (this.#targets.get(r.targetSelector) ?? 0) + 1);
    }
  }

  get size(): number {
    return this.#mutations;
  }

  /** Return the accumulated summary and reset; undefined when nothing changed. */
  drain(): DomSummary | undefined {
    if (this.#mutations === 0) return undefined;
    const topTargets = [...this.#targets.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TOP_TARGETS)
      .map(([sel]) => sel);
    const out: DomSummary = {
      mutations: this.#mutations,
      added: this.#added,
      removed: this.#removed,
      attributes: this.#attributes,
      characterData: this.#characterData,
      attributeNames: [...this.#attrNames].sort(),
      topTargets,
    };
    this.#mutations = 0;
    this.#added = 0;
    this.#removed = 0;
    this.#attributes = 0;
    this.#characterData = 0;
    this.#attrNames.clear();
    this.#targets.clear();
    return out;
  }
}
