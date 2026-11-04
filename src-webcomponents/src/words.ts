/**
 * The words the component shows, picked out of the dictionary at build time (`vite.config.ts`):
 * the whole dictionary would be most of the module. The words of the manifest go into
 * `flow-diagram.json` instead.
 */

declare const __FLOW_WORDS__: Record<string, Record<string, string>>;

/**
 * A word in one language, English if it has no translation
 *
 * @param key key of the dictionary
 * @param lang the language of the system
 */
export function word(key: string, lang: ioBroker.Languages): string {
    return __FLOW_WORDS__[lang]?.[key] || __FLOW_WORDS__.en?.[key] || key;
}
